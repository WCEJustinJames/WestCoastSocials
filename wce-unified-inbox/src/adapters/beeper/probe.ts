/**
 * Beeper bridge probe — run this ON YOUR MACHINE (where Beeper Desktop runs) to
 * verify the live API shape, your token, and your channels before relying on the
 * mirror. Mirrors the "verify, don't assume" step.
 *
 *   npm run beeper:probe
 */
import { env, requireEnv } from '../../lib/env'
import { BeeperClient } from './client'

async function main() {
  requireEnv(['beeperToken'])
  const client = new BeeperClient({
    baseUrl: env.beeperBaseUrl,
    token: env.beeperToken,
    apiVersion: env.beeperApiVersion,
  })

  console.log(`\n# Beeper bridge @ ${env.beeperBaseUrl} (api ${env.beeperApiVersion})\n`)

  console.log('→ GET /info')
  console.log(JSON.stringify(await client.getInfo(), null, 2))

  console.log('\n→ accounts (your channels)')
  const accounts = await client.listAccounts()
  console.table(accounts.map((a) => ({ accountID: a.accountID, network: a.network })))

  console.log('\n→ sample 1:1 messages')
  const res = await client.searchMessages({ chatType: 'single', limit: 5 })
  for (const m of res.items ?? []) {
    const net = res.chats?.[m.chatID]?.network ?? '?'
    const who = m.isSender ? 'me' : (m.senderName ?? m.senderID)
    console.log(`  [${net}] ${who}: ${m.text ?? '(no text)'}`)
  }
  console.log(`\n  hasMore=${res.hasMore} items=${res.items?.length ?? 0}\n`)
}

main().catch((err) => {
  console.error('\nProbe failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
