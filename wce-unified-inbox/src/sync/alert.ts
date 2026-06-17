import type { ChannelAdapter } from '../adapters/types'

/**
 * Fail-loud alerting for the AI layer (auto-reply + drafting).
 *
 * The Anthropic-backed paths deliberately swallow their own errors so one bad
 * call can't wedge the sync loop. The downside: when the API key expires or runs
 * out of credits, auto-reply and drafting just go quiet and nobody notices — that
 * exact failure went unseen for ~6 days once. This watches the outcome of the AI
 * calls each pass and texts Justin once when they start failing (and once more
 * when they recover), so a dead key surfaces in minutes, not days.
 *
 * The alert rides the same Beeper SMS path as the confirmed-players digest, which
 * does NOT depend on Anthropic — so it still gets through when the AI is the thing
 * that's down. Like the auto-reply, it is exempt from quiet hours: an operator
 * alert to Justin's own phone should land whatever the time.
 */

/** What the Anthropic calls in a module did this pass. */
export type AiOutcome =
  | { ok: true } //  at least one call succeeded — the key + model work
  | { ok: false; hard: boolean; status?: number; message: string } // a call failed

/**
 * Classify an Anthropic SDK error. `hard` = won't fix itself without an operator
 * (bad/expired key, no credits, unknown model, malformed request); everything
 * else (rate limit, overloaded, network blip) is transient and shouldn't page.
 */
export function classifyAiError(e: unknown): { hard: boolean; status?: number; message: string } {
  const raw = (e as { status?: unknown })?.status
  const status = typeof raw === 'number' ? raw : undefined
  const m = (e as { message?: unknown })?.message
  const message = e instanceof Error ? e.message : typeof m === 'string' ? m : String(e)
  const hard = status !== undefined && [400, 401, 402, 403, 404].includes(status)
  return { hard, status, message }
}

/** Combine the per-module outcomes into one verdict for the whole pass. */
export function worstOutcome(...outcomes: (AiOutcome | undefined)[]): AiOutcome | undefined {
  const seen = outcomes.filter((o): o is AiOutcome => o != null)
  if (seen.length === 0) return undefined // no AI call attempted this pass
  if (seen.some((o) => o.ok)) return { ok: true } // any success means the key works
  // All failed: surface a hard failure over a soft one.
  return seen.find((o) => !o.ok && o.hard) ?? seen[0]
}

export interface AiHealth {
  consecutiveFails: number
  alerted: boolean
  lastAlertAt: number
}

export function newAiHealth(): AiHealth {
  return { consecutiveFails: 0, alerted: false, lastAlertAt: 0 }
}

// A hard error alerts on the first failing pass; a soft (transient) one must
// persist this many passes first, so a lone 529/overload never pages. Passes
// are ~15s apart, so this is ~1 minute of sustained trouble.
const SOFT_FAIL_ALERT_AFTER = 4
// While it stays down, re-nudge at most this often.
const REALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000

/**
 * Feed in the pass's AI outcome. Sends one text on the healthy->failing edge
 * (and again every REALERT_COOLDOWN_MS while it stays down), and a one-off
 * recovery text on failing->healthy. No-op when no AI call was attempted.
 * Best-effort: a failed alert is logged, never thrown.
 */
export async function trackAiHealth(
  health: AiHealth,
  outcome: AiOutcome | undefined,
  adapter: ChannelAdapter,
  notifyPhone: string,
  notifyAccount = 'gmessages',
  now: number = Date.now(),
): Promise<void> {
  if (!outcome) return // nothing attempted — can't judge health

  if (outcome.ok) {
    if (health.alerted) {
      await safeText(adapter, notifyAccount, notifyPhone, 'WCP inbox: AI auto-reply + drafting are back up.')
    }
    health.consecutiveFails = 0
    health.alerted = false
    return
  }

  health.consecutiveFails++
  const sustained = outcome.hard || health.consecutiveFails >= SOFT_FAIL_ALERT_AFTER
  const cooledDown = now - health.lastAlertAt >= REALERT_COOLDOWN_MS
  if (!sustained || (health.alerted && !cooledDown)) return

  const where = outcome.status ? ` (HTTP ${outcome.status})` : ''
  const msg =
    `WCP inbox AI DOWN${where}: ${outcome.message}. ` +
    `Auto-reply + drafting are off until fixed. ` +
    `Most likely the Anthropic API key (expired or out of credits) in wce-unified-inbox\\.env on this PC. ` +
    `Renew it, check ANTHROPIC_MODEL, then restart run-wce.bat.`
  if (await safeText(adapter, notifyAccount, notifyPhone, msg)) {
    health.alerted = true
    health.lastAlertAt = now
  }
}

async function safeText(
  adapter: ChannelAdapter,
  account: string,
  phone: string,
  text: string,
): Promise<boolean> {
  if (!adapter.startChatAndSend) return false
  try {
    const r = await adapter.startChatAndSend(account, phone, text)
    return r.ok
  } catch (e) {
    console.error('[alert] send failed:', e instanceof Error ? e.message : e)
    return false
  }
}
