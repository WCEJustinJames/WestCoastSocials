import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPass, newEngineState } from './smsEngine'
import { makeWorld, seedBatch, threadItem } from './testkit/fakeWorld'
const RUSH = 'dd090193-9e06-4eb0-b9a1-ccbe02d1ee5a'
function seed(w: ReturnType<typeof makeWorld>, n: number, id?: string) {
  const items = Array.from({ length: n }, (_, i) => {
    const chat = (id ?? 'normal') + '-' + i
    w.bp.addChat({ id: chat, accountID: 'facebookgo.test', type: 'single' })
    return threadItem(chat)
  })
  return seedBatch(w, 'approved', items, id ? { id } : {})
}
test('rush only: 200 posts without pacing; 201st stays approved', async () => {
  const w = makeWorld(); const b = seed(w, 201, RUSH); const sleeps: number[] = []
  w.deps.sleep = async ms => { sleeps.push(ms); w.clock.now += ms }
  await runPass(w.deps, w.cfg, newEngineState())
  assert.equal(w.bp.posts().length, 200)
  assert.equal(b.items.filter(x => x.status === 'approved').length, 1)
  assert.equal(sleeps.filter(ms => ms === 1500).length, 0)
})
test('normal batches retain 20-post ceiling and pacing', async () => {
  const w = makeWorld(); seed(w, 21); const sleeps: number[] = []
  w.deps.sleep = async ms => { sleeps.push(ms); w.clock.now += ms }
  await runPass(w.deps, w.cfg, newEngineState())
  assert.equal(w.bp.posts().length, 20)
  assert.equal(sleeps.filter(ms => ms === 1500).length, 20)
})
test('rush follows normal ceiling and still honors item guard', async () => {
  const w = makeWorld(); seed(w, 20); const b = seed(w, 3, RUSH)
  await runPass(w.deps, w.cfg, newEngineState(), {
    guard: async ({ item }) => item.id === b.items[0].id ? { ok: false, reason: 'held' } : { ok: true },
  })
  assert.equal(w.bp.posts().length, 22)
  assert.equal(b.items[0].status, 'skipped')
  assert.equal(b.items[1].status, 'sent')
})
