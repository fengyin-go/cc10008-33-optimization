import * as E from '../engine'

type Outcome = { state: ReturnType<typeof E.createInitialState>; result: { ok: boolean; message: string; createdCodes?: string[]; mergedCodes?: string[]; createdIds?: number[] } }

const assert = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1 } else console.log('ok -', msg) }

// 1. alert + report triggered together become separate batches
let s = E.createInitialState()
const t0 = 1_000_000
let r: Outcome = E.triggerNotification(s, { ruleIds: [1, 2, 3], listMode: 'union', conflictPolicy: 'priority-wins', trigger: '卡点异常', now: t0 })
s = r.state
assert(r.result.ok, 'trigger ok')
assert(r.result.createdCodes!.filter(c => c.startsWith('ALT')).length === 1, 'one alert batch')
assert(r.result.createdCodes!.filter(c => c.startsWith('RPT')).length === 1, 'one report batch even when triggered together')
const alert = s.batches.find(b => b.messageClass === 'alert')!
const report = s.batches.find(b => b.messageClass === 'report')!
assert(alert.code !== report.code, 'separate ids')

// 2. conflict: rule 1 vs 2 same priority 30, different lists, winner rule 1 order 1
assert(alert.resolution.conflict, 'conflict detected')
assert(alert.resolution.winnerRuleCode === 'NOTI-0001', 'winner by registration order')
assert(alert.resolution.recipientIds.includes('u-zhang') && !alert.resolution.recipientIds.includes('u-zhao'), 'priority-wins excludes loser-only recipient')

// 3. second alert in window is suppressed into same batch
r = E.triggerNotification(s, { ruleIds: [1, 2], listMode: 'union', conflictPolicy: 'priority-wins', trigger: '卡点异常', now: t0 + 30_000 })
s = r.state
assert(r.result.createdCodes!.length === 0, 'no new alert batch inside window')
assert(r.result.mergedCodes![0] === alert.code, 'merged into existing alert batch')
assert(s.batches.length === 2, 'still 2 batches total')

// 4. report triggered again -> new independent report batch
r = E.triggerNotification(s, { ruleIds: [3], listMode: 'union', conflictPolicy: 'priority-wins', trigger: '每日报告', now: t0 + 31_000 })
s = r.state
assert(r.result.createdCodes!.length === 1 && r.result.createdCodes![0].startsWith('RPT'), 'report never merges')
assert(r.result.createdIds![0] !== report.id, 'new report batch id distinct')

// 5. outside window -> new alert batch
r = E.triggerNotification(s, { ruleIds: [1], listMode: 'union', conflictPolicy: 'priority-wins', trigger: '卡点异常', now: t0 + 200_000 })
s = r.state
assert(r.result.createdCodes!.some(c => c.startsWith('ALT')) && r.result.mergedCodes!.length === 0, 'new alert batch after window')

// 6. intersection mode
const preview = E.resolveRules(s.rules.filter(x => [1,2].includes(x.id)), 'intersection', 'merge-lists', s.recipients)
assert(preview.recipientIds.length === 1 && preview.recipientIds[0] === 'u-li', 'intersection = shared recipients only (li)')
assert(preview.excludedRecipientIds.includes('u-zhang') && preview.excludedRecipientIds.includes('u-zhao'), 'excluded reported')

// 7. inject incidents (im broken), then send -> delivered via other channels, no double delivery
s = E.setChannelHealth(s, 'im', 'unresponsive').state
const alt = s.batches.find(b => b.messageClass === 'alert' && b.status === 'pending')!
r = E.sendBatch(s, alt.id, { now: t0 + 300_000 })
s = r.state
const alt2 = s.batches.find(b => b.id === alt.id)!
const delivered = alt2.deliveries.filter(d => d.state === 'delivered')
assert(delivered.length > 0, 'some delivered despite broken im')
for (const d of delivered) {
  const rc = s.receipts.filter(x => x.batchId === alt2.id && x.recipientId === d.recipientId)
  assert(rc.length === 1, `${d.recipientName} has exactly one receipt (no double delivery)`)
}
assert(s.evidence.some(e => e.category === 'timeout'), 'im timeout evidence recorded')
assert(s.channelHealth.email.state === 'healthy', 'email unaffected by incident')

// 8. unsubscribe: wang has im unsubscribed, sms healthy -> should send sms, not blocked by im
const wang = alt2.deliveries.find(d => d.recipientId === 'u-wang')
assert(!!wang && wang.state === 'delivered' && wang.deliveredChannel === 'sms', 'unsubscribed im does not block sms')
assert(s.evidence.some(e => e.category === 'unsubscribed' && e.recipientId === 'u-wang'), 'unsubscribe evidence kept')

// 9. per-recipient retry: inject fault for zhang, send a fresh batch
s = E.setRecipientFault(s, 'u-zhang', 'unresponsive').state
r = E.triggerNotification(s, { ruleIds: [1, 2], listMode: 'union', conflictPolicy: 'merge-lists', trigger: '故障演练', now: t0 + 400_000 })
s = r.state
const drill = s.batches.find(b => b.id === r.result.createdIds![0])!
const drillBefore = drill.deliveries.map(d => d.recipientId)
r = E.sendBatch(s, drill.id, { now: t0 + 400_000 })
s = r.state
const paused = s.batches.find(b => b.id === drill.id)!
assert(paused.status === 'paused', 'batch paused on failing recipient')
assert(paused.deliveries[paused.cursor].recipientName === '张敏', 'cursor stuck at failing recipient')
assert(paused.deliveries[paused.cursor].attempts === 1, 'first attempt counted')
// retry to exhaustion, should move on
r = E.exhaustRetries(s, drill.id, t0 + 400_001)
s = r.state
const after = s.batches.find(b => b.id === drill.id)!
const zhang = after.deliveries.find(d => d.recipientId === 'u-zhang')!
assert(zhang.state === 'failed', 'zhang failed after retries')
assert(zhang.attempts === zhang.maxRetries + 1, `per-recipient attempts ${zhang.attempts} = max+1`)
assert(s.evidence.filter(e => e.batchCode === drill.code && e.recipientId === 'u-zhang' && e.category === 'timeout').length >= zhang.attempts, 'evidence recorded for every failed attempt')
assert(after.deliveries.filter(d => d.recipientId !== 'u-zhang' && d.state === 'delivered').length > 0, 'other recipients still delivered after zhang exhausted')
assert(after.status === 'partial', 'batch partial after exhausted retries')

// 10. interruption + resume from last failed recipient
s = E.setRecipientFault(s, 'u-zhang', 'none').state
r = E.triggerNotification(s, { ruleIds: [1], listMode: 'union', conflictPolicy: 'priority-wins', trigger: '中断演练', now: t0 + 500_000 })
s = r.state
let bid = r.result.createdIds![0]
// step send: one recipient then pause
r = E.sendBatch(s, bid, { limit: 1, now: t0 + 500_000 })
s = r.state
let b = s.batches.find(x => x.id === bid)!
assert(b.status === 'paused' && b.cursor === 1, 'single-step paused with cursor 1')
r = E.simulateInterrupt(s, bid, t0 + 510_000)
s = r.state
b = s.batches.find(x => x.id === bid)!
assert(b.status === 'sending', 'simulated interruption leaves sending state')
assert(E.findResidualBatches(s, t0 + 520_000).some(f => f.batch.id === bid), 'residual batch detected')
r = E.resumeBatch(s, bid, t0 + 530_000)
s = r.state
b = s.batches.find(x => x.id === bid)!
assert(b.status === 'paused' || b.status === 'completed' || b.status === 'partial', 'resume progresses from cursor')
const firstRecipient = b.deliveries[0]
assert(firstRecipient.state === 'delivered' && firstRecipient.attempts === 1, 'already delivered recipient not resent on resume')

// 11. cleanup keeps receipts and evidence
const withReceipts = s
const c = E.cleanupResidualBatch(withReceipts, bid, { now: t0 + 600_000 })
s = c.state
b = s.batches.find(x => x.id === bid)!
assert(b.status === 'cleaned', 'residual cleaned')
assert(b.cleanup!.keptReceipts === withReceipts.receipts.filter(x => x.batchId === bid).length, 'cleanup keeps receipts count')
assert(s.receipts.filter(x => x.batchId === bid).length === b.cleanup!.keptReceipts, 'receipts physically kept')
assert(E.findResidualBatches(s, t0 + 700_000).every(f => f.batch.id !== bid), 'cleaned batch no longer residual')

// 12. failure of one batch doesn't block creating/sending another
r = E.triggerNotification(s, { ruleIds: [4], listMode: 'union', conflictPolicy: 'priority-wins', trigger: '每周报告', now: t0 + 800_000 })
s = r.state
const other = r.result.createdIds![0]
r = E.sendBatch(s, other, { now: t0 + 800_000 })
s = r.state
assert(r.result.ok, 'later batch proceeds regardless of previous failures')

// 13. stale echo channel produces duplicate evidence and no receipt
s = E.setRecipientFault(s, 'u-zhou', 'stale-echo').state
r = E.triggerNotification(s, { ruleIds: [4], listMode: 'union', conflictPolicy: 'priority-wins', trigger: '回放演练', now: t0 + 850_000 })
s = r.state
r = E.sendBatch(s, r.result.createdIds![0], { now: t0 + 850_000 })
s = r.state
assert(s.evidence.some(e => e.category === 'stale-duplicate' && e.recipientId === 'u-zhou'), 'stale duplicate evidence recorded')
assert(s.receipts.every(x => !(x.recipientId === 'u-zhou' && x.batchCode === r.result.message.match(/RPT-\d+/)?.[0])), 'stale-echo never yields a receipt')

// 14. disabled rule blocks trigger
E.toggleRule(s, 1)
s = E.toggleRule(s, 1).state
const disabled = E.triggerNotification(s, { ruleIds: [1], listMode: 'union', conflictPolicy: 'priority-wins', trigger: 'x', now: t0 + 900_000 })
assert(!disabled.result.ok, 'disabled rule refuses to trigger')

// 15. send activity must NOT extend merge window
{
  let ws = E.createInitialState()
  const wt = 1_000_000
  let wr = E.triggerNotification(ws, { ruleIds: [1], listMode: 'union', conflictPolicy: 'priority-wins', trigger: '窗口边界', now: wt })
  ws = wr.state
  const wb = wr.result.createdIds![0]
  const wa = ws.batches.find(x => x.id === wb)!
  const anchorBefore = wa.alertAt
  ws = E.sendBatch(ws, wb, { now: wt + 5_000 }).state
  const wa2 = ws.batches.find(x => x.id === wb)!
  assert(wa2.alertAt === anchorBefore, 'sending does not move the merge anchor')
  // 55s after creation but 50s after the send: still inside 60s window -> merged
  wr = E.triggerNotification(ws, { ruleIds: [1], listMode: 'union', conflictPolicy: 'priority-wins', trigger: '窗口边界', now: wt + 55_000 })
  assert(wr.result.mergedCodes!.length === 1, 'window measured from creation, not send time')
}

console.log('\nDone.')
