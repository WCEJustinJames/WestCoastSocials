import { test } from 'node:test'
import assert from 'node:assert/strict'
import { batchAllowedBySchedule } from './batches'
import { runPass, newEngineState } from './smsEngine'
import { makeWorld, seedBatch, threadItem, item } from './testkit/fakeWorld'

// Every request remains in fakeWorld; real Beeper and Supabase are refused.
for (const at of ['2026-10-21T20:02:00+08:00', '2026-10-21T22:00:00+08:00', '2026-10-22T05:00:00+08:00']) {
  test('an approved batch can send at ' + at, async () => {
    const w = makeWorld(at)
    w.bp.addChat({ id: 'fb-test', accountID: 'facebookgo.test' })
    const b = seedBatch(w, 'approved', [threadItem('fb-test')], { approved_at: at })
    const result = await runPass(w.deps, w.cfg, newEngineState(), {
      batchAllowed: (row) => batchAllowedBySchedule(row, w.clock.now),
    })
    assert.equal(result.sent, 1)
    assert.equal(item(w, b.items[0].id).status, 'sent')
  })
}

for (const hold of ['paused', 'future schedule', 'expired', 'draft'] as const) {
  test('all-hour batches still respect ' + hold, async () => {
    const w = makeWorld('2026-10-21T22:00:00+08:00')
    w.bp.addChat({ id: 'fb-test', accountID: 'facebookgo.test' })
    const extra = hold === 'future schedule' ? { scheduled_for: new Date(w.clock.now + 3600000).toISOString() }
      : hold === 'expired' ? { expires_at: new Date(w.clock.now - 1).toISOString() } : {}
    const b = seedBatch(w, hold === 'draft' ? 'draft' : 'approved', [threadItem('fb-test')], extra)
    if (hold === 'paused') w.pg.tables.inbox_settings[0].sends_paused = true
    const result = await runPass(w.deps, w.cfg, newEngineState(), {
      batchAllowed: (row) => batchAllowedBySchedule(row, w.clock.now),
    })
    assert.equal(result.sent, 0)
    assert.equal(item(w, b.items[0].id).post_attempted_at, null)
    assert.equal(w.bp.posts('fb-test').length, 0)
  })
}
