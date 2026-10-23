/**
 * Contacts probe — run ON YOUR MACHINE to see how Beeper expresses contact IDs
 * (the `participantIDs` you'd pass to start a new chat) and what the full
 * contact book looks like beyond existing threads.
 *
 *   npm run beeper:contacts
 *
 * Read-only: it lists contacts, it never creates a chat or sends anything.
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

  const accounts = await client.listAccounts()
  for (const a of accounts) {
    console.log(`\n# ${a.accountID} (${a.network}) — first contacts`)
    try {
      const data = await client.listContacts(a.accountID, 5)
      console.log(JSON.stringify(data, null, 2))
    } catch (e) {
      console.log('  contacts/list failed:', e instanceof Error ? e.message : e)
    }
  }
}

main().catch((err) => {
  console.error('\nContacts probe failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
