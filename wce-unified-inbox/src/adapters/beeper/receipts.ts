/**
 * Receipt-chat probe — finds the "player banking and cash chips" GROUP chat and
 * dumps its recent messages (raw, including attachments) so we can see how Beeper
 * exposes the receipt photos before building the vision-extraction pipeline.
 *
 *   npm run beeper:receipts
 *   npm run beeper:receipts -- "banking"      (override the title to match on)
 *
 * Read-only.
 */
import { env, requireEnv } from '../../lib/env'
import { BeeperClient } from './client'

async function main() {
  requireEnv(['beeperToken'])
  const needle = (process.argv[2] ?? 'banking').toLowerCase()
  const client = new BeeperClient({
    baseUrl: env.beeperBaseUrl,
    token: env.beeperToken,
    apiVersion: env.beeperApiVersion,
  })

  console.log(`Searching recent GROUP chats for a title containing "${needle}"…\n`)
  const res = await client.searchMessages({ chatType: 'group', limit: 20 })
  const chats = Object.values(res.chats ?? {})
  const match = chats.find((c) => (c.title ?? '').toLowerCase().includes(needle))

  if (!match) {
    console.log('No match. Group chats seen in recent results:')
    for (const c of chats) console.log('  -', c.title)
    console.log('\nIf the chat isn’t listed, it just has no recent activity — tell me and I’ll target it by id.')
    return
  }

  console.log(`Found: "${match.title}"  id=${match.id}  account=${match.accountID}\n`)
  const msgs = await client.searchMessages({ chatIDs: [match.id], limit: 5 })
  console.log('# 5 most recent messages (raw — look for the attachment/image shape):\n')
  console.log(JSON.stringify(msgs.items, null, 2))
}

main().catch((err) => {
  console.error('\nReceipts probe failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
