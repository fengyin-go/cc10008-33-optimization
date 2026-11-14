import * as E from '../engine'

type Outcome = { state: ReturnType<typeof E.createInitialState>; result: { ok: boolean; message: string; createdCodes?: string[]; mergedCodes?: string[]; createdIds?: number[] } }
const assert = (c: boolean, m: string) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1 } else console.log('ok -', m) }
let s = E.createInitialState()
const t = 1_000_000
// all report recipients: chen has email unsubscribed, still has im; zhao all? report rule3 channels email,im; chen unsub email -> im works
let r: Outcome = E.triggerNotification(s, { ruleIds: [3], listMode: 'union', conflictPolicy: 'priority-wins', trigger: '日报', now: t })
s = r.state
const rid = r.result.createdIds![0]
r = E.sendBatch(s, rid, { now: t })
s = r.state
const b = s.batches.find(x => x.id === rid)!
assert(b.status === 'completed', 'all report recipients delivered through alternate channel')
const chen = b.deliveries.find(d => d.recipientId === 'u-chen')!
assert(chen.state === 'delivered' && chen.deliveredChannel === 'im', 'chen email unsubscribed, delivered via im')

// no-channel recipient: recipient with zero channels? inject by creating custom state
let custom = E.createInitialState()
custom.recipients = custom.recipients.map(x => x.id === 'u-li' ? { ...x, unsubscribed: [...x.channels] } : x)
r = E.triggerNotification(custom, { ruleIds: [3], listMode: 'union', conflictPolicy: 'priority-wins', trigger: '日报2', now: t })
custom = r.state
r = E.sendBatch(custom, r.result.createdIds![0], { now: t })
custom = r.state
const b2 = custom.batches.find(x => x.id === r.result.createdIds?.[0]) ?? custom.batches[custom.batches.length - 1]
const li = b2.deliveries.find(d => d.recipientId === 'u-li')!
assert(li.state === 'skipped', 'fully unsubscribed recipient skipped not failed')
assert(b2.deliveries.filter(d => d.state === 'delivered').length === 2, 'other recipients unaffected by li skipped')
assert(custom.evidence.some(e => e.recipientId === 'u-li' && e.category === 'unsubscribed'), 'all-channel unsubscribe evidence per channel')

// merger after sending: new recipient added, previously delivered not resent
let s3 = E.createInitialState()
r = E.triggerNotification(s3, { ruleIds: [1], listMode: 'union', conflictPolicy: 'priority-wins', trigger: '窗口', now: t })
s3 = r.state
const aid = r.result.createdIds![0]
r = E.sendBatch(s3, aid, { now: t })
s3 = r.state
const beforeCount = s3.receipts.filter(x => x.batchId === aid).length
// merge window: trigger again with rule 2 (adds zhao) within window
r = E.triggerNotification(s3, { ruleIds: [2], listMode: 'merge-lists' as any, conflictPolicy: 'merge-lists', trigger: '窗口', now: t + 10_000 } as any)
s3 = r.state
assert(r.result.mergedCodes!.length === 1, 'second alert merged')
const a3 = s3.batches.find(x => x.id === aid)!
assert(a3.status !== 'completed' && a3.deliveries.some(d => d.state === 'pending'), 'new recipient appended as pending')
const deliveredBefore = a3.deliveries.filter(d => d.state === 'delivered')
r = E.sendBatch(s3, aid, { now: t + 20_000 })
s3 = r.state
const a4 = s3.batches.find(x => x.id === aid)!
assert(a4.deliveries.filter(d => d.state === 'delivered').length >= deliveredBefore.length, 'previously delivered preserved')
assert(s3.receipts.filter(x => x.batchId === aid).length === a4.deliveries.filter(d => d.state === 'delivered').length, 'one receipt per delivered recipient exactly')
console.log('Done.')
