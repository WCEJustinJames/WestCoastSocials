import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardSend } from './guards'
import { env } from '../lib/env'

const row = { id: 'contact-1', do_not_message: false, hidden: false, staff: false,
  last_contacted: '2026-10-01T00:00:00Z', contact_frequency_days: null,
  beeper_chat_id: null, snooze_until: null }
function fakeDb(over: Record<string, unknown> | null = {}, count = 4) {
  return { from(table: string) { return {
    select() { return this }, eq() { return this }, limit() { return this }, order() { return this },
    async maybeSingle() { return { data: table === 'inbox_outreach' && over !== null ? { ...row, ...over } : null, error: null } },
    async gt() { assert.equal(table, 'inbox_sent_log'); return { count } },
  } } } as unknown as Parameters<typeof guardSend>[0]
}
const base = { renderedText: 'Hi, can I lock you in for cash tonight?', isOutreach: true,
  outreachId: 'contact-1', batchId: 'batch-1', batchItemId: 'item-1' }
const approval = () => ({ reason: 'owner_requested_retry', batch_id: 'batch-1', item_id: 'item-1',
  outreach_id: 'contact-1', expires_at: new Date(Date.now() + 3600000).toISOString() })

test('four unanswered invitations stay held without an explicit item approval', async () => {
  assert.deepEqual(await guardSend(fakeDb(), base), { ok: false, reason: 'no_reply_4' })
})
test('an explicit owner approval retries this exact item despite four unanswered invitations', async () => {
  assert.deepEqual(await guardSend(fakeDb(), { ...base, noReplyOverride: approval() }), { ok: true })
})
for (const [field, value] of [['batch_id', 'another-batch'], ['item_id', 'another-item'],
  ['outreach_id', 'another-person'], ['reason', 'other'], ['expires_at', '2000-01-01T00:00:00Z'],
  ['expires_at', 'invalid']] as const) {
  test('a mismatched or expired retry is ignored: ' + field + '=' + value, async () => {
    assert.deepEqual(await guardSend(fakeDb(), { ...base, noReplyOverride: { ...approval(), [field]: value } }),
      { ok: false, reason: 'no_reply_4' })
  })
}
for (const [field, value, reason] of [['do_not_message', true, 'do_not_message'], ['hidden', true, 'hidden'],
  ['staff', true, 'staff'], ['snooze_until', '2999-01-01', 'on_ice']] as const) {
  test('the retry still respects ' + reason, async () => {
    assert.deepEqual(await guardSend(fakeDb({ [field]: value }), { ...base, noReplyOverride: approval() }),
      { ok: false, reason })
  })
}
test('the retry still refuses a missing CRM recipient and unrendered text', async () => {
  assert.deepEqual(await guardSend(fakeDb(null), { ...base, noReplyOverride: approval() }),
    { ok: false, reason: 'crm_row_missing' })
  assert.deepEqual(await guardSend(fakeDb(), { ...base, renderedText: 'Hi {name}', noReplyOverride: approval() }),
    { ok: false, reason: 'unrendered_placeholder' })
})
test('the retry still respects opt-in first-time review', async () => {
  const previous = env.vetFirstTimers
  env.vetFirstTimers = true
  try {
    assert.deepEqual(await guardSend(fakeDb({ last_contacted: null }), { ...base, noReplyOverride: approval() }),
      { ok: false, reason: 'first_time_review' })
  } finally { env.vetFirstTimers = previous }
})
