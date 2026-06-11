/**
 * Start-chat probe — tests whether a raw phone number can be turned into a
 * sendable Beeper chat. Run it against YOUR OWN number first.
 *
 *   npm run beeper:startchat -- "+61412345678"            (defaults to gmessages/SMS)
 *   npm run beeper:startchat -- "0412 345 678" gmessages
 *
 * It calls POST /v1/chats WITHOUT a messageText, so nothing is sent — it only
 * resolves/creates the chat and prints what came back (chat id + status). If it
 * returns an id, "start a chat from a number" is buildable for the un-threaded
 * players; if it 400s, paste the error and we'll adjust the number format.
 */
import { env, requireEnv } from '../../lib/env'
import { BeeperClient } from './client'

async function main() {
  requireEnv(['beeperToken'])
  const number = process.argv[2]
  const accountID = process.argv[3] ?? 'gmessages'
  if (!number) {
    console.error('usage: npm run beeper:startchat -- "<phone number>" [accountID]')
    process.exit(1)
  }

  const client = new BeeperClient({
    baseUrl: env.beeperBaseUrl,
    token: env.beeperToken,
    apiVersion: env.beeperApiVersion,
  })

  console.log(`\nResolving chat on ${accountID} for participant "${number}" (no message sent)…\n`)
  const r = await client.createChat(accountID, [number], { type: 'single' })
  console.log(JSON.stringify(r, null, 2))
}

main().catch((err) => {
  console.error('\nStart-chat probe failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
