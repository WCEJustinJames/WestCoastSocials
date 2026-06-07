/**
 * Count-only scan — pages the whole "Poker Banking and Cash Chips" chat and
 * reports how many image messages exist vs how many we've already processed, so
 * you know how much receipt backlog is left. No vision calls.
 *
 *   npm run receipts:count
 */
import { env, requireEnv } from '../lib/env'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { BeeperClient } from '../adapters/beeper/client'

requireEnv(['beeperToken', 'supabaseUrl', 'supabaseServiceKey'])

async function main() {
  const beeper = new BeeperClient({
    baseUrl: env.beeperBaseUrl,
    token: env.beeperToken,
    apiVersion: env.beeperApiVersion,
  })

  const groups = await beeper.searchMessages({ chatType: 'group', limit: 20 })
  const chat = Object.values(groups.chats ?? {}).find((c) =>
    (c.title ?? '').toLowerCase().includes('banking'),
  )
  if (!chat) {
    console.error('Could not find the banking chat.')
    process.exit(1)
  }

  let totalImages = 0
  let totalMessages = 0
  let cursor: string | undefined
  for (let page = 0; page < 3000; page++) {
    const res = await beeper.searchMessages({
      chatIDs: [chat.id],
      limit: 20,
      cursor,
      direction: 'before',
    })
    const items = res.items ?? []
    totalMessages += items.length
    for (const m of items) {
      if ((m.attachments as { type?: string }[] | undefined)?.some((a) => a.type === 'img'))
        totalImages++
    }
    if (!res.hasMore || !res.oldestCursor) break
    cursor = res.oldestCursor
    if (page % 25 === 24) console.log(`  …scanned ${totalMessages} messages so far`)
  }

  const { count: processed } = await supabaseAdmin
    .from('inbox_receipts')
    .select('*', { count: 'exact', head: true })

  console.log(`\nChat "${chat.title}":`)
  console.log(`  messages scanned : ${totalMessages}`)
  console.log(`  image messages   : ${totalImages}`)
  console.log(`  already processed: ${processed ?? 0}`)
  console.log(`  left to process  : ${Math.max(0, totalImages - (processed ?? 0))}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
