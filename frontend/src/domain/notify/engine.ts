import type {
  Batch,
  Channel,
  ChannelDelivery,
  ChannelHealth,
  ChannelHealthState,
  CleanupRecord,
  ConflictPolicy,
  Delivery,
  Evidence,
  EvidenceCategory,
  ListMode,
  MessageClass,
  NotifyRule,
  NotifyState,
  OperationResult,
  Receipt,
  Recipient,
  ResidualFinding,
  Resolution,
  TriggerInput,
  TriggerResult,
} from './types'

export const CHANNELS: Channel[] = ['email', 'im', 'sms', 'webhook']

export const CHANNEL_LABELS: Record<Channel, string> = {
  email: '邮件',
  im: '即时通讯',
  sms: '短信',
  webhook: 'Webhook',
}

export const HEALTH_LABELS: Record<ChannelHealthState, string> = {
  healthy: '正常',
  unresponsive: '点击无响应',
  erroring: '调用报错',
  'stale-echo': '回放旧消息',
}

const CLASS_LABELS: Record<MessageClass, string> = {
  alert: '普通告警',
  report: '定时报告',
}

// ---------------------------------------------------------------------------
// 初始数据
// ---------------------------------------------------------------------------

const SEED_RECIPIENTS: Recipient[] = [
  { id: 'u-zhang', name: '张敏', dept: '数据平台', channels: ['email', 'im'], unsubscribed: [] },
  { id: 'u-li', name: '李哲', dept: '风控', channels: ['email', 'im', 'sms'], unsubscribed: [] },
  { id: 'u-wang', name: '王倩', dept: '运营', channels: ['im', 'sms'], unsubscribed: ['im'] },
  { id: 'u-zhao', name: '赵岩', dept: '运营', channels: ['email', 'webhook'], unsubscribed: ['webhook'] },
  { id: 'u-chen', name: '陈曦', dept: '财务', channels: ['email', 'im'], unsubscribed: ['email'] },
  { id: 'u-zhou', name: '周航', dept: '值班', channels: ['sms', 'im'], unsubscribed: [] },
]

const SEED_RULES: NotifyRule[] = [
  {
    id: 1,
    code: 'NOTI-0001',
    name: '卡点告警通知',
    messageClass: 'alert',
    trigger: '卡点异常',
    priority: 30,
    order: 1,
    channels: ['im', 'email', 'sms'],
    recipients: ['u-zhang', 'u-li', 'u-wang'],
    mergeWindowSec: 60,
    maxRetries: 2,
    status: '已启用',
  },
  {
    id: 2,
    code: 'NOTI-0002',
    name: '卡点告警升级通知',
    messageClass: 'alert',
    trigger: '卡点异常',
    priority: 30,
    order: 2,
    channels: ['email', 'im', 'sms'],
    recipients: ['u-li', 'u-zhao'],
    mergeWindowSec: 90,
    maxRetries: 3,
    status: '已启用',
  },
  {
    id: 3,
    code: 'NOTI-0003',
    name: '日报定时推送',
    messageClass: 'report',
    trigger: '每日报告',
    priority: 10,
    order: 3,
    channels: ['email', 'im'],
    recipients: ['u-zhang', 'u-li', 'u-chen'],
    mergeWindowSec: 0,
    maxRetries: 1,
    status: '已启用',
  },
  {
    id: 4,
    code: 'NOTI-0004',
    name: '周报定时推送',
    messageClass: 'report',
    trigger: '每周报告',
    priority: 20,
    order: 4,
    channels: ['webhook', 'email', 'sms'],
    recipients: ['u-li', 'u-zhao', 'u-zhou'],
    mergeWindowSec: 0,
    maxRetries: 2,
    status: '已启用',
  },
]

function initialHealth(channel: Channel, state: ChannelHealthState, lastError?: string): ChannelHealth {
  return {
    channel,
    state,
    lastError,
    successCount: 0,
    failureCount: 0,
    staleCount: 0,
    duplicateCount: 0,
    ...(lastError ? { lastFailureAt: Date.now() } : {}),
  }
}

export function createInitialState(): NotifyState {
  return {
    version: 1,
    rules: SEED_RULES.map((rule) => ({ ...rule })),
    recipients: SEED_RECIPIENTS.map((recipient) => ({
      ...recipient,
      channels: [...recipient.channels],
      unsubscribed: [...recipient.unsubscribed],
    })),
    // 初始全部健康，避免一进来所有批次都失败；通道故障由页面上的演示按钮显式注入。
    channelHealth: {
      email: initialHealth('email', 'healthy'),
      im: initialHealth('im', 'healthy'),
      sms: initialHealth('sms', 'healthy'),
      webhook: initialHealth('webhook', 'healthy'),
    },
    faultInjections: {},
    batches: [],
    receipts: [],
    evidence: [],
    seq: 0,
    updatedAt: 0,
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ---------------------------------------------------------------------------
// 接收列表解析：并集 / 交集 + 优先级冲突裁决
// ---------------------------------------------------------------------------

function sortedRules(rules: NotifyRule[]): NotifyRule[] {
  return [...rules].sort((a, b) => (b.priority - a.priority) || (a.order - b.order))
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((item) => set.has(item))
}

/** 优先级冲突：最高优先级相同的规则接收列表却不同，必须由明确规则裁决发出对象。 */
function detectConflict(rules: NotifyRule[]): { conflict: boolean; tieBreakReason: string; tied: NotifyRule[] } {
  const ordered = sortedRules(rules)
  const topPriority = ordered[0]?.priority
  const tied = ordered.filter((rule) => rule.priority === topPriority)
  if (tied.length < 2) {
    return { conflict: false, tieBreakReason: '未出现同优先级冲突，按优先级从高到低裁决', tied }
  }
  const first = tied[0]
  const differing = tied.find((rule) => !sameList(first.recipients, rule.recipients))
  if (!differing) {
    return { conflict: false, tieBreakReason: `最高优先级 ${topPriority} 的规则接收列表一致，无需裁决`, tied }
  }
  return {
    conflict: true,
    tieBreakReason:
      `${first.code} 与 ${differing.code} 优先级同为 ${topPriority} 但接收列表不同；` +
      `按登记顺序 ${first.code}（第 ${first.order} 位）为胜出规则`,
    tied,
  }
}

export function resolveRules(
  rules: NotifyRule[],
  mode: ListMode,
  conflictPolicy: ConflictPolicy,
  recipients: Recipient[],
): Resolution {
  if (rules.length === 0) {
    return {
      mode,
      conflict: false,
      conflictPolicy,
      winnerRuleCode: '',
      winnerRuleName: '',
      tieBreakReason: '',
      contributions: [],
      ruleIds: [],
      recipientIds: [],
      excludedRecipientIds: [],
      explanation: '没有可用规则',
    }
  }
  const ordered = sortedRules(rules)
  const winner = ordered[0]
  const { conflict, tieBreakReason, tied } = detectConflict(ordered)
  const tiedCodes = new Set(tied.map((rule) => rule.code))
  let effective = ordered
  let overrideNote = ''
  if (conflict && conflictPolicy === 'priority-wins') {
    effective = ordered.filter((rule) => !tiedCodes.has(rule.code) || rule.code === winner.code)
    overrideNote =
      `裁决生效：本次按 ${winner.code} 的接收列表发出，` +
      `${tied.filter((rule) => rule.code !== winner.code).map((rule) => rule.code).join('、')} 的同优先级名单被覆盖。`
  } else if (conflict) {
    overrideNote = `裁决生效：${tied.map((rule) => rule.code).join('、')} 的同优先级名单取并集后发出。`
  }

  const unions: string[] = []
  for (const rule of effective) {
    for (const id of rule.recipients) {
      if (!unions.includes(id)) unions.push(id)
    }
  }
  const recipientIds =
    mode === 'union' ? unions : unions.filter((id) => effective.every((rule) => rule.recipients.includes(id)))
  const excludedIds = unions.filter((id) => !recipientIds.includes(id))
  const nameOf = (id: string) => recipients.find((item) => item.id === id)?.name ?? id
  const modeText =
    mode === 'union'
      ? `并集：纳入 ${effective.length} 条生效规则中出现过的所有接收人，按人去重后共 ${recipientIds.length} 位`
      : `交集：只保留同时出现在全部 ${effective.length} 条生效规则中的接收人，共 ${recipientIds.length} 位` +
        (excludedIds.length > 0 ? `；排除 ${excludedIds.map(nameOf).join('、')}` : '')
  return {
    mode,
    conflict,
    conflictPolicy,
    winnerRuleCode: winner.code,
    winnerRuleName: winner.name,
    tieBreakReason,
    contributions: ordered.map((rule) => ({
      ruleCode: rule.code,
      ruleName: rule.name,
      priority: rule.priority,
      order: rule.order,
      recipients: [...rule.recipients],
    })),
    ruleIds: effective.map((rule) => rule.id),
    recipientIds,
    excludedRecipientIds: excludedIds,
    explanation: [modeText, `裁决规则：${winner.code}（优先级 ${winner.priority}，第 ${winner.order} 位登记）`, tieBreakReason, overrideNote]
      .filter(Boolean)
      .join('。') + '。',
  }
}

/**
 * 每位接收人的渠道计划来自"包含该接收人的最高优先级规则"；
 * 同优先级时按登记顺序。规则渠道与接收人自身渠道取交集，退订在发送时逐渠道跳过。
 */
export function channelPlanFor(recipient: Recipient, rules: NotifyRule[]): { channels: Channel[]; ruleCode: string } {
  for (const rule of sortedRules(rules)) {
    if (!rule.recipients.includes(recipient.id)) continue
    const associated = rule.channels.filter((channel) => recipient.channels.includes(channel))
    return { channels: [...new Set(associated)], ruleCode: rule.code }
  }
  return { channels: [], ruleCode: '' }
}

function ruleById(state: NotifyState, ruleIds: number[]): NotifyRule[] {
  return state.rules.filter((rule) => ruleIds.includes(rule.id))
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function nextCode(state: NotifyState, prefix: string): string {
  state.seq += 1
  return `${prefix}-${String(state.seq).padStart(4, '0')}`
}

function activeRules(state: NotifyState, ruleIds: number[]): NotifyRule[] {
  return state.rules.filter((rule) => ruleIds.includes(rule.id))
}

function makeDeliveries(
  state: NotifyState,
  rules: NotifyRule[],
  recipientIds: string[],
  maxRetries: number,
): Delivery[] {
  const deliveries: Delivery[] = []
  for (const recipientId of recipientIds) {
    const recipient = state.recipients.find((item) => item.id === recipientId)
    if (!recipient) continue
    const plan = channelPlanFor(recipient, rules)
    deliveries.push({
      recipientId,
      recipientName: recipient.name,
      state: 'pending',
      attempts: 0,
      maxRetries,
      channels: plan.channels.map((channel) => ({
        channel,
        state: 'pending' as const,
        attempts: 0,
      })),
      note: plan.channels.length === 0 ? '规则渠道与接收人可达渠道无交集' : undefined,
    })
  }
  return deliveries
}

/** 合并窗口只看告警发生的时间（创建或合并），发送动作不延长窗口。 */
export function lastAlertActivity(batch: Batch): number {
  return batch.alertAt ?? batch.createdAt
}

function lastActivity(batch: Batch): number {
  return batch.events.reduce((max, event) => Math.max(max, event.at), Math.max(batch.createdAt, batch.updatedAt))
}

function addEvidence(
  state: NotifyState,
  batch: Batch,
  category: EvidenceCategory,
  detail: string,
  options: Partial<Pick<Evidence, 'recipientId' | 'recipientName' | 'channel' | 'attempts' | 'at'>> = {},
): Evidence {
  const evidence: Evidence = {
    id: nextCode(state, 'EVD'),
    batchId: batch.id,
    batchCode: batch.code,
    category,
    detail,
    at: options.at ?? Date.now(),
    recipientId: options.recipientId,
    recipientName: options.recipientName,
    channel: options.channel,
    attempts: options.attempts,
  }
  if (evidence.recipientId === undefined) delete evidence.recipientId
  if (evidence.recipientName === undefined) delete evidence.recipientName
  if (evidence.channel === undefined) delete evidence.channel
  if (evidence.attempts === undefined) delete evidence.attempts
  state.evidence.push(evidence)
  return evidence
}

function hasEvidence(
  state: NotifyState,
  batchId: number,
  recipientId: string,
  channel: Channel,
  category: EvidenceCategory,
): boolean {
  return state.evidence.some(
    (item) =>
      item.batchId === batchId &&
      item.recipientId === recipientId &&
      item.channel === channel &&
      item.category === category,
  )
}

function addEvent(batch: Batch, trigger: string, note: string | undefined, at: number): void {
  batch.events.push({ at, trigger, note })
  batch.updatedAt = at
}

// ---------------------------------------------------------------------------
// 触发批次
// ---------------------------------------------------------------------------

function findMergeTarget(state: NotifyState, messageClass: MessageClass, mergeKey: string, now: number): Batch | null {
  if (messageClass !== 'alert') return null
  const candidates = state.batches.filter((batch) => {
    if (batch.messageClass !== 'alert' || batch.mergeKey !== mergeKey) return false
    if (batch.status === 'cleaned' || batch.status === 'failed') return false
    return now - lastAlertActivity(batch) <= batch.mergeWindowSec * 1000
  })
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => lastAlertActivity(b) - lastAlertActivity(a))[0]
}

function applyMerge(state: NotifyState, batch: Batch, rules: NotifyRule[], input: TriggerInput, now: number): void {
  const resolution = resolveRules(rules, input.listMode, input.conflictPolicy, state.recipients)
  const mergedRules = ruleById(state, resolution.ruleIds)
  const addedRecipients: string[] = []
  for (const recipientId of resolution.recipientIds) {
    if (batch.deliveries.some((delivery) => delivery.recipientId === recipientId)) continue
    const recipient = state.recipients.find((item) => item.id === recipientId)
    if (!recipient) continue
    const plan = channelPlanFor(recipient, mergedRules)
    batch.deliveries.push({
      recipientId,
      recipientName: recipient.name,
      state: 'pending',
      attempts: 0,
      maxRetries: Math.max(batch.maxRetries, ...mergedRules.map((rule) => rule.maxRetries)),
      channels: plan.channels.map((channel) => ({ channel, state: 'pending' as const, attempts: 0 })),
      note:
        plan.channels.length === 0
          ? recipient.channels.every((channel) => recipient.unsubscribed.includes(channel))
            ? '可达渠道均已退订'
            : '规则渠道与接收人可达渠道无交集'
          : undefined,
    })
    addedRecipients.push(recipient.name)
  }
  batch.mergedCount += 1
  batch.alertAt = now
  batch.mergeWindowSec = Math.max(batch.mergeWindowSec, ...mergedRules.map((rule) => rule.mergeWindowSec))
  batch.maxRetries = Math.max(batch.maxRetries, ...mergedRules.map((rule) => rule.maxRetries))
  // 裁决按最新一次计算，但贡献规则的历史要保留，运营才能回溯哪些规则最终汇进了这个批次。
  const contributions = [...batch.resolution.contributions]
  for (const contribution of resolution.contributions) {
    if (!contributions.some((item) => item.ruleCode === contribution.ruleCode)) {
      contributions.push(contribution)
    }
  }
  batch.resolution = { ...resolution, contributions }
  batch.title = resolution.winnerRuleName
  addEvent(
    batch,
    input.trigger,
    addedRecipients.length > 0
      ? `合并窗口内抑制重复告警，新增接收人 ${addedRecipients.join('、')}`
      : '合并窗口内抑制重复告警，接收人已全部在批次内',
    now,
  )
  batch.status =
    batch.status === 'sending'
      ? 'sending'
      : batch.deliveries.some((delivery) => delivery.state === 'pending')
        ? 'pending'
        : batch.status
  batch.updatedAt = now
}

function createBatch(
  state: NotifyState,
  messageClass: MessageClass,
  rules: NotifyRule[],
  input: TriggerInput,
  now: number,
): Batch {
  const resolution = resolveRules(rules, input.listMode, input.conflictPolicy, state.recipients)
  const effective = ruleById(state, resolution.ruleIds)
  const winner = sortedRules(effective)[0]
  const maxRetries = Math.max(...effective.map((rule) => rule.maxRetries))
  const prefix = messageClass === 'alert' ? 'ALT' : 'RPT'
  const used = new Set(state.batches.map((batch) => batch.code))
  const cycle = state.batches.filter((batch) => batch.messageClass === messageClass && batch.status !== 'cleaned').length + 1
  let serial = cycle
  let code = `${prefix}-${String(serial).padStart(4, '0')}`
  while (used.has(code)) {
    serial += 1
    code = `${prefix}-${String(serial).padStart(4, '0')}`
  }
  state.seq += 1
  const id = state.seq
  const batch: Batch = {
    id,
    code,
    messageClass,
    title: winner.name,
    trigger: input.trigger,
    createdAt: now,
    updatedAt: now,
    alertAt: now,
    status: 'pending',
    mergeKey: `${messageClass}|${input.trigger.trim()}`,
    mergeWindowSec: messageClass === 'report' ? 0 : Math.max(...effective.map((rule) => rule.mergeWindowSec)),
    mergedCount: 0,
    events: [{ at: now, trigger: input.trigger, note: `${CLASS_LABELS[messageClass]}批次创建` }],
    resolution,
    maxRetries,
    deliveries: makeDeliveries(state, effective, resolution.recipientIds, maxRetries),
    cursor: 0,
  }
  state.batches.push(batch)
  return batch
}

/**
 * 同时触发若干规则。告警与报告无论是否被一起选中，都先按消息类型分组，
 * 每组各自形成批次；告警在合并窗口内进入抑制，报告永远新建独立批次。
 */
export function triggerNotification(state: NotifyState, input: TriggerInput): { state: NotifyState; result: TriggerResult } {
  const next = clone(state)
  const now = input.now ?? Date.now()
  if (input.ruleIds.length === 0) {
    return { state: next, result: { ok: false, message: '至少选择一条规则再触发通知', createdCodes: [], mergedCodes: [], createdIds: [] } }
  }
  const rules = activeRules(next, input.ruleIds)
  if (rules.length !== input.ruleIds.length) {
    return { state: next, result: { ok: false, message: '存在未登记的规则，触发已取消', createdCodes: [], mergedCodes: [], createdIds: [] } }
  }
  const disabled = rules.filter((rule) => rule.status !== '已启用')
  if (disabled.length > 0) {
    return {
      state: next,
      result: {
        ok: false,
        message: `规则 ${disabled.map((rule) => rule.code).join('、')} 未启用，触发已取消`,
        createdCodes: [],
        mergedCodes: [],
        createdIds: [],
      },
    }
  }
  const byClass = new Map<MessageClass, NotifyRule[]>()
  for (const rule of rules) {
    if (!byClass.has(rule.messageClass)) byClass.set(rule.messageClass, [])
    byClass.get(rule.messageClass)!.push(rule)
  }
  const createdCodes: string[] = []
  const mergedCodes: string[] = []
  const createdIds: number[] = []
  const details: string[] = []
  for (const [messageClass, classRules] of byClass.entries()) {
    const mergeKey = `${messageClass}|${input.trigger.trim()}`
    const target = findMergeTarget(next, messageClass, mergeKey, now)
    if (target) {
      applyMerge(next, target, classRules, { ...input, now }, now)
      mergedCodes.push(target.code)
      details.push(`告警批次 ${target.code} 在 ${target.mergeWindowSec}s 合并窗口内被抑制，未新建批次`)
    } else {
      const batch = createBatch(next, messageClass, classRules, { ...input, now }, now)
      createdCodes.push(batch.code)
      createdIds.push(batch.id)
      details.push(
        `${CLASS_LABELS[messageClass]}批次 ${batch.code} 独立创建` +
          (messageClass === 'report' ? '（报告不复用告警批次，保留独立标识）' : ''),
      )
    }
  }
  next.updatedAt = now
  return {
    state: next,
    result: {
      ok: true,
      message: details.join('；'),
      createdCodes,
      mergedCodes,
      createdIds,
    },
  }
}

// ---------------------------------------------------------------------------
// 发送 / 重试 / 续发
// ---------------------------------------------------------------------------

function healthFor(state: NotifyState, recipientId: string, channel: Channel): ChannelHealthState {
  const injected = state.faultInjections[recipientId]
  if (injected) return injected
  return state.channelHealth[channel]?.state ?? 'healthy'
}

function failureDetail(health: ChannelHealthState): string {
  if (health === 'unresponsive') return '通道点击无响应：发送请求超时'
  if (health === 'erroring') return '通道调用报错：返回 502'
  if (health === 'stale-echo') return '通道回放旧消息：只返回了历史消息，未确认本次送达'
  return ''
}

function evidenceCategory(health: ChannelHealthState): EvidenceCategory {
  if (health === 'unresponsive') return 'timeout'
  if (health === 'stale-echo') return 'stale-duplicate'
  return 'channel-error'
}

function deliverOne(
  state: NotifyState,
  batch: Batch,
  delivery: Delivery,
  now: number,
): 'delivered' | 'paused' | 'failed' | 'skipped' {
  // 已成功送达的接收人任何路径都不再进入发送逻辑，确保绝不二次送达。
  if (delivery.state === 'delivered') return 'delivered'
  const recipient = state.recipients.find((item) => item.id === delivery.recipientId)
  const unsubscribed = new Set(recipient?.unsubscribed ?? [])

  // 一个接收人一次尝试只记一次，避免退订渠道把计数虚增。
  delivery.attempts += 1

  for (const channel of delivery.channels) {
    if (channel.state === 'failed') {
      channel.state = 'pending'
    }
  }

  for (const channel of delivery.channels) {
    if (channel.state !== 'pending') continue
    if (unsubscribed.has(channel.channel)) {
      channel.state = 'unsubscribed'
      if (!hasEvidence(state, batch.id, delivery.recipientId, channel.channel, 'unsubscribed')) {
        addEvidence(
          state,
          batch,
          'unsubscribed',
          `接收人已退订${CHANNEL_LABELS[channel.channel]}，仅跳过该渠道，不影响其他渠道`,
          {
            recipientId: delivery.recipientId,
            recipientName: delivery.recipientName,
            channel: channel.channel,
            at: now,
          },
        )
      }
      continue
    }
    channel.attempts += 1
    const health = healthFor(state, delivery.recipientId, channel.channel)
    if (health === 'healthy') {
      channel.state = 'sent'
      channel.sentAt = now
      const receiptId = nextCode(state, 'RCPT')
      channel.receiptId = receiptId
      const alreadyDelivered = state.receipts.some(
        (item) => item.batchId === batch.id && item.recipientId === delivery.recipientId,
      )
      if (!alreadyDelivered) {
        state.receipts.push({
          id: receiptId,
          batchId: batch.id,
          batchCode: batch.code,
          messageClass: batch.messageClass,
          recipientId: delivery.recipientId,
          recipientName: delivery.recipientName,
          channel: channel.channel,
          sentAt: now,
        })
      } else {
        channel.receiptId = state.receipts.find(
          (item) => item.batchId === batch.id && item.recipientId === delivery.recipientId,
        )?.id
      }
      state.channelHealth[channel.channel].successCount += 1
      delivery.state = 'delivered'
      delivery.deliveredChannel = channel.channel
      delivery.note = undefined
      // 已成功送达：同一接收人剩余渠道不再发送，绝不二次送达。
      for (const other of delivery.channels) {
        if (other.channel !== channel.channel && other.state === 'pending') {
          other.state = 'skipped'
        }
      }
      return 'delivered'
    }

    channel.state = 'failed'
    channel.lastError = failureDetail(health)
    if (!state.faultInjections[delivery.recipientId]) {
      const healthRecord = state.channelHealth[channel.channel]
      healthRecord.failureCount += 1
      healthRecord.lastError = channel.lastError
      healthRecord.lastFailureAt = now
      if (health === 'stale-echo') {
        healthRecord.staleCount += 1
        healthRecord.duplicateCount += 1
      }
    }
    addEvidence(state, batch, evidenceCategory(health), `第 ${delivery.attempts} 次尝试：${channel.lastError}`, {
      recipientId: delivery.recipientId,
      recipientName: delivery.recipientName,
      channel: channel.channel,
      attempts: delivery.attempts,
      at: now,
    })
  }

  const routable = delivery.channels.filter((channel) => channel.state !== 'unsubscribed')
  if (routable.length === 0) {
    delivery.state = 'skipped'
    delivery.note =
      delivery.channels.length === 0
        ? recipient && recipient.channels.every((channel) => unsubscribed.has(channel))
          ? '可达渠道均已退订'
          : '规则渠道与接收人可达渠道无交集'
        : '所有可达渠道均已退订'
    if (delivery.channels.length === 0) {
      addEvidence(state, batch, 'no-channel', '接收人在本规则下没有任何可达渠道，已跳过且不阻塞后续接收人', {
        recipientId: delivery.recipientId,
        recipientName: delivery.recipientName,
        attempts: delivery.attempts,
        at: now,
      })
    }
    return 'skipped'
  }

  if (delivery.attempts <= delivery.maxRetries) {
    delivery.state = 'pending'
    return 'paused'
  }
  delivery.state = 'failed'
  addEvidence(
    state,
    batch,
    'retry-exhausted',
    `已重试 ${delivery.attempts - 1} 次仍失败，转入失败旁证并继续后续接收人，不再阻塞批次`,
    {
      recipientId: delivery.recipientId,
      recipientName: delivery.recipientName,
      channel: delivery.channels.find((channel) => channel.state === 'failed')?.channel,
      attempts: delivery.attempts,
      at: now,
    },
  )
  return 'failed'
}

function finalizeStatus(batch: Batch): void {
  if (batch.cursor < batch.deliveries.length) return
  const delivered = batch.deliveries.filter((delivery) => delivery.state === 'delivered').length
  const failed = batch.deliveries.filter((delivery) => delivery.state === 'failed').length
  if (batch.deliveries.length === 0) {
    batch.status = 'failed'
    return
  }
  if (failed === 0 && delivered === batch.deliveries.length) {
    batch.status = 'completed'
  } else if (delivered === 0 && failed === 0) {
    // 全部跳过（退订/无渠道）不是失败：没有失败旁证就不该算失败批次。
    batch.status = 'completed'
  } else {
    batch.status = 'partial'
  }
}

/**
 * 从 cursor 开始逐位接收人发送。
 * - 单个接收人失败且仍在重试预算内：批次暂停，cursor 停在最后失败的接收人。
 * - 超过重试上限：写入失败旁证，cursor 前移，继续后面的接收人，不阻塞其他批次。
 * - limit 用于单步发送，演示"中断后从最后失败接收人继续"。
 */
export function sendBatch(
  state: NotifyState,
  batchId: number,
  options: { now?: number; limit?: number } = {},
): { state: NotifyState; result: OperationResult } {
  const next = clone(state)
  const now = options.now ?? Date.now()
  const batch = next.batches.find((item) => item.id === batchId)
  if (!batch) return { state: next, result: { ok: false, message: `没有找到批次 #${batchId}` } }
  if (batch.status === 'cleaned') {
    return { state: next, result: { ok: false, message: `批次 ${batch.code} 已清理，不能再发送` } }
  }
  if (batch.status === 'completed') {
    return { state: next, result: { ok: false, message: `批次 ${batch.code} 已全部送达，无需重发` } }
  }
  if (batch.status === 'failed') {
    return { state: next, result: { ok: false, message: `批次 ${batch.code} 已失败，请先清理残留` } }
  }

  batch.status = 'sending'
  batch.resumeNote = undefined
  addEvent(batch, '开始发送', `从第 ${batch.cursor + 1} 位接收人继续，已送达的人不会重发`, now)
  const limit = options.limit ?? Number.POSITIVE_INFINITY
  let processed = 0

  while (batch.cursor < batch.deliveries.length) {
    if (processed >= limit) {
      batch.status = 'paused'
      const upcoming = batch.deliveries[batch.cursor]
      batch.resumeNote = `单步发送中断：下一位是 ${upcoming?.recipientName ?? '—'}`
      batch.updatedAt = now
      addEvent(batch, '单步中断', batch.resumeNote, now)
      return {
        state: next,
        result: { ok: true, message: `${batch.code} 已单步中断，可从 ${upcoming?.recipientName ?? '—'} 继续` },
      }
    }
    const delivery = batch.deliveries[batch.cursor]
    if (delivery.state === 'delivered' || delivery.state === 'failed' || delivery.state === 'skipped') {
      batch.cursor += 1
      continue
    }
    const outcome = deliverOne(next, batch, delivery, now)
    processed += 1
    batch.updatedAt = now
    if (outcome === 'paused') {
      batch.status = 'paused'
      const plan = delivery.channels
        .filter((channel) => channel.state === 'failed' || channel.state === 'pending')
        .map((channel) => CHANNEL_LABELS[channel.channel])
      batch.resumeNote =
        `${delivery.recipientName} 第 ${delivery.attempts} 次发送失败（重试上限 ${delivery.maxRetries} 次），` +
        `成功后不会重复送达；下次从这里继续${plan.length > 0 ? `，将再试渠道：${plan.join('、')}` : ''}`
      addEvent(batch, '发送暂停', batch.resumeNote, now)
      return {
        state: next,
        result: { ok: true, message: `${batch.code} 在 ${delivery.recipientName} 处暂停；修复通道后可继续发送` },
      }
    }
    batch.cursor += 1
  }

  finalizeStatus(batch)
  batch.updatedAt = now
  addEvent(batch, '发送结束', `批次状态：${batch.status}`, now)
  return { state: next, result: { ok: true, message: `${batch.code} 发送结束，当前状态「${batch.status}」` } }
}

export function resumeBatch(state: NotifyState, batchId: number, now = Date.now()): { state: NotifyState; result: OperationResult } {
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) return { state, result: { ok: false, message: `没有找到批次 #${batchId}` } }
  if (batch.cursor >= batch.deliveries.length) {
    return { state, result: { ok: false, message: `批次 ${batch.code} 没有待续发的接收人` } }
  }
  return sendBatch(state, batchId, { now })
}

/** 放弃当前接收人：写入失败旁证后前移，让批次继续，不被单人卡住。 */
export function abandonCurrentRecipient(
  state: NotifyState,
  batchId: number,
  now = Date.now(),
): { state: NotifyState; result: OperationResult } {
  const next = clone(state)
  const batch = next.batches.find((item) => item.id === batchId)
  if (!batch) return { state: next, result: { ok: false, message: `没有找到批次 #${batchId}` } }
  if (batch.status === 'cleaned') return { state: next, result: { ok: false, message: `批次 ${batch.code} 已清理` } }
  const delivery = batch.deliveries[batch.cursor]
  if (!delivery || delivery.state !== 'pending') {
    return { state: next, result: { ok: false, message: '当前接收人不在待发送状态' } }
  }
  delivery.state = 'failed'
  addEvidence(next, batch, 'retry-exhausted', '值班人员手动放弃当前接收人，转入失败旁证后继续后续接收人', {
    recipientId: delivery.recipientId,
    recipientName: delivery.recipientName,
    attempts: delivery.attempts,
    at: now,
  })
  batch.cursor += 1
  batch.updatedAt = now
  addEvent(batch, '放弃接收人', `${delivery.recipientName} 转入失败旁证`, now)
  finalizeStatus(batch)
  return { state: next, result: { ok: true, message: `已放弃 ${delivery.recipientName}，批次 ${batch.code} 继续` } }
}

/**
 * 自动把当前接收人的重试预算用完，再继续后面的接收人。
 * 单人重试次数独立计数；超限那一刻转入失败旁证，不会拖住其他批次。
 */
export function exhaustRetries(
  state: NotifyState,
  batchId: number,
  now = Date.now(),
): { state: NotifyState; result: OperationResult } {
  let next = state
  let lastMessage = ''
  for (let step = 0; step < 24; step += 1) {
    const batch = next.batches.find((item) => item.id === batchId)
    if (!batch || batch.status !== 'paused') break
    const delivery = batch.deliveries[batch.cursor]
    if (!delivery) break
    const before = delivery.attempts
    const outcome = sendBatch(next, batchId, { now })
    next = outcome.state
    lastMessage = outcome.result.message
    const after = next.batches.find((item) => item.id === batchId)?.deliveries[batch.cursor]?.attempts ?? before
    if (after === before) break
  }
  const batch = next.batches.find((item) => item.id === batchId)
  const summary =
    batch && batch.status === 'paused'
      ? `${lastMessage || batch.code + ' 仍在等待重试'}`
      : lastMessage || '当前没有可重试的接收人'
  return { state: next, result: { ok: true, message: summary } }
}

/** 模拟发送进程在批次中途消失，留下 status=sending 的残留批次。 */
export function simulateInterrupt(
  state: NotifyState,
  batchId: number,
  now = Date.now(),
): { state: NotifyState; result: OperationResult } {
  const next = clone(state)
  const batch = next.batches.find((item) => item.id === batchId)
  if (!batch) return { state: next, result: { ok: false, message: `没有找到批次 #${batchId}` } }
  if (batch.status === 'cleaned' || batch.status === 'completed' || batch.status === 'failed') {
    return { state: next, result: { ok: false, message: `批次 ${batch.code} 当前状态无法模拟中断` } }
  }
  const pending = batch.deliveries.findIndex((delivery) => delivery.state === 'pending')
  if (pending < 0) return { state: next, result: { ok: false, message: `批次 ${batch.code} 没有待发送的接收人` } }
  batch.cursor = pending
  batch.status = 'sending'
  batch.resumeNote = `发送进程在 ${batch.deliveries[pending].recipientName} 处中断，未收尾`
  addEvent(batch, '模拟中断', batch.resumeNote, now)
  batch.updatedAt = now
  return {
    state: next,
    result: { ok: true, message: `${batch.code} 已置为中断态，可在「残留批次」里定位并续发或清理` },
  }
}

// ---------------------------------------------------------------------------
// 通道健康与故障定位
// ---------------------------------------------------------------------------

export function toggleRule(state: NotifyState, ruleId: number): { state: NotifyState; result: OperationResult } {
  const next = clone(state)
  const rule = next.rules.find((item) => item.id === ruleId)
  if (!rule) return { state: next, result: { ok: false, message: `没有找到规则 #${ruleId}` } }
  rule.status = rule.status === '已启用' ? '已停用' : '已启用'
  next.updatedAt = Date.now()
  return {
    state: next,
    result: {
      ok: true,
      message: `${rule.code} 已${rule.status}；停用规则不会再进入新批次，已有批次不受影响`,
    },
  }
}

export function setChannelHealth(
  state: NotifyState,
  channel: Channel,
  health: ChannelHealthState,
  note?: string,
): { state: NotifyState; result: OperationResult } {
  const next = clone(state)
  const record = next.channelHealth[channel]
  record.state = health
  record.lastError = health === 'healthy' ? undefined : note ?? failureDetail(health)
  record.lastFailureAt = health === 'healthy' ? record.lastFailureAt : Date.now()
  next.channelHealth[channel] = record
  next.updatedAt = Date.now()
  return {
    state: next,
    result: {
      ok: true,
      message:
        health === 'healthy'
          ? `${CHANNEL_LABELS[channel]}已标记修复`
          : `${CHANNEL_LABELS[channel]}已切换为「${HEALTH_LABELS[health]}」`,
    },
  }
}

export function probeChannel(state: NotifyState, channel: Channel): OperationResult {
  const record = state.channelHealth[channel]
  if (record.state === 'healthy') {
    return { ok: true, message: `${CHANNEL_LABELS[channel]}探测正常：累计成功 ${record.successCount} 次` }
  }
  if (record.state === 'unresponsive') {
    return { ok: false, message: `${CHANNEL_LABELS[channel]}点击无响应：探测请求 8s 未返回，检查网关线程池与连接超时` }
  }
  if (record.state === 'erroring') {
    return { ok: false, message: `${CHANNEL_LABELS[channel]}调用报错：${record.lastError ?? '返回 502'}，检查签名与上游状态` }
  }
  return { ok: false, message: `${CHANNEL_LABELS[channel]}回放旧消息：累计回放 ${record.staleCount} 次，请清理通道缓冲后再发送` }
}

export function applyChannelIncident(state: NotifyState): { state: NotifyState; result: OperationResult } {
  const next = clone(state)
  const incidents: { channel: Channel; health: ChannelHealthState; note: string }[] = [
    { channel: 'im', health: 'unresponsive', note: '点击后无响应：探测请求 8s 未返回' },
    { channel: 'sms', health: 'erroring', note: '调用报错：上游返回 502' },
    { channel: 'webhook', health: 'stale-echo', note: '通道回放 3 条 30 分钟前的旧消息' },
  ]
  for (const incident of incidents) {
    next.channelHealth[incident.channel] = {
      ...next.channelHealth[incident.channel],
      state: incident.health,
      lastError: incident.note,
      lastFailureAt: Date.now(),
    }
  }
  next.updatedAt = Date.now()
  return {
    state: next,
    result: {
      ok: true,
      message: '已复现三类通道故障：即时通讯无响应、短信报错、Webhook 回放旧消息；邮件通道保持正常',
    },
  }
}

export function setRecipientFault(
  state: NotifyState,
  recipientId: string,
  health: ChannelHealthState | 'none',
): { state: NotifyState; result: OperationResult } {
  const next = clone(state)
  if (health === 'none') {
    delete next.faultInjections[recipientId]
  } else {
    next.faultInjections[recipientId] = health
  }
  next.updatedAt = Date.now()
  const name = next.recipients.find((item) => item.id === recipientId)?.name ?? recipientId
  return {
    state: next,
    result: {
      ok: true,
      message: health === 'none' ? `已清除 ${name} 的单人故障注入` : `${name} 的发送将固定失败：${HEALTH_LABELS[health]}`,
    },
  }
}

// ---------------------------------------------------------------------------
// 残留批次定位与清理
// ---------------------------------------------------------------------------

export function findResidualBatches(state: NotifyState, now = Date.now()): ResidualFinding[] {
  const findings: ResidualFinding[] = []
  for (const batch of state.batches) {
    if (batch.status === 'cleaned' || batch.status === 'completed' || batch.status === 'failed') continue
    const pending = batch.deliveries.filter((delivery) => delivery.state === 'pending').map((delivery) => delivery.recipientName)
    if (batch.status === 'sending') {
      findings.push({
        batch,
        reason: '上次发送中途中断，进程未收尾',
        severity: 'high',
        pendingRecipients: pending,
        ageMs: now - batch.updatedAt,
      })
      continue
    }
    if (batch.status === 'paused') {
      findings.push({
        batch,
        reason: `发送停在 ${batch.deliveries[batch.cursor]?.recipientName ?? '—'}，等待人工续发`,
        severity: 'high',
        pendingRecipients: pending,
        ageMs: now - batch.updatedAt,
      })
      continue
    }
    const delivered = batch.deliveries.filter((delivery) => delivery.state === 'delivered').length
    if (now - lastActivity(batch) > Math.max(batch.mergeWindowSec * 1000, 15000) && delivered === 0) {
      findings.push({
        batch,
        reason: '合并窗口已过期但一条未发，属于空转残留批次',
        severity: 'medium',
        pendingRecipients: pending,
        ageMs: now - lastActivity(batch),
      })
    }
  }
  return findings
}

export function cleanupResidualBatch(
  state: NotifyState,
  batchId: number,
  options: { now?: number; reason?: string } = {},
): { state: NotifyState; result: OperationResult } {
  const next = clone(state)
  const now = options.now ?? Date.now()
  const batch = next.batches.find((item) => item.id === batchId)
  if (!batch) return { state: next, result: { ok: false, message: `没有找到批次 #${batchId}` } }
  if (batch.status === 'cleaned') return { state: next, result: { ok: false, message: `批次 ${batch.code} 已是清理状态` } }
  const dropped = batch.deliveries.filter(
    (delivery) => delivery.state !== 'delivered' && delivery.state !== 'skipped',
  ).length
  for (const delivery of batch.deliveries) {
    if (delivery.state === 'pending') {
      delivery.state = 'skipped'
      delivery.note = '残留批次清理，未发送部分作废'
    }
  }
  batch.status = 'cleaned'
  batch.updatedAt = now
  const cleanup: CleanupRecord = {
    at: now,
    droppedDeliveries: dropped,
    keptReceipts: next.receipts.filter((receipt) => receipt.batchId === batch.id).length,
    keptEvidence: next.evidence.filter((evidence) => evidence.batchId === batch.id).length,
    reason: options.reason ?? '定位到残留批次后人工清理',
  }
  batch.cleanup = cleanup
  addEvent(batch, '清理残留批次', cleanup.reason, now)
  addEvidence(
    next,
    batch,
    'residual-cleanup',
    `清理残留批次：作废 ${dropped} 位未完成接收人；保留成功回执 ${cleanup.keptReceipts} 条、失败旁证 ${cleanup.keptEvidence} 条`,
    { at: now },
  )
  next.updatedAt = now
  return {
    state: next,
    result: {
      ok: true,
      message: `已清理 ${batch.code}：作废 ${dropped} 位，成功回执与失败旁证均保留`,
    },
  }
}

export function cleanupAllResidual(
  state: NotifyState,
  now = Date.now(),
): { state: NotifyState; result: OperationResult; cleaned: string[] } {
  let next = state
  const cleaned: string[] = []
  for (const finding of findResidualBatches(state, now)) {
    const outcome = cleanupResidualBatch(next, finding.batch.id, {
      now,
      reason: `批量清理：${finding.reason}`,
    })
    next = outcome.state
    if (outcome.result.ok) cleaned.push(finding.batch.code)
  }
  return {
    state: next,
    result: {
      ok: cleaned.length > 0,
      message: cleaned.length > 0 ? `已清理 ${cleaned.length} 个残留批次：${cleaned.join('、')}` : '当前没有残留批次',
    },
    cleaned,
  }
}

// ---------------------------------------------------------------------------
// 查询辅助
// ---------------------------------------------------------------------------

export function countPendingRetries(state: NotifyState): number {
  return state.batches
    .filter((batch) => batch.status !== 'cleaned')
    .reduce(
      (sum, batch) =>
        sum +
        batch.deliveries.filter((delivery) => delivery.state === 'pending' && delivery.attempts > 0).length,
      0,
    )
}

export function batchStats(state: NotifyState): {
  alertBatches: number
  reportBatches: number
  receipts: number
  evidence: number
  residual: number
  pendingRetries: number
  merged: number
} {
  return {
    alertBatches: state.batches.filter((batch) => batch.messageClass === 'alert' && batch.status !== 'cleaned').length,
    reportBatches: state.batches.filter((batch) => batch.messageClass === 'report' && batch.status !== 'cleaned').length,
    receipts: state.receipts.length,
    evidence: state.evidence.length,
    residual: findResidualBatches(state).length,
    pendingRetries: countPendingRetries(state),
    merged: state.batches.reduce((sum, batch) => sum + batch.mergedCount, 0),
  }
}

export function resetState(): NotifyState {
  return createInitialState()
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<Batch['status'], string> = {
  pending: '待发送',
  sending: '发送中',
  paused: '已暂停',
  completed: '已全部送达',
  partial: '部分送达',
  failed: '已失败',
  cleaned: '已清理',
}

const DELIVERY_LABELS: Record<Delivery['state'], string> = {
  pending: '待发送',
  delivered: '已送达',
  failed: '失败旁证',
  skipped: '已跳过',
}

const CHANNEL_STATE_LABELS: Record<ChannelDelivery['state'], string> = {
  pending: '待发送',
  sent: '已送达',
  failed: '失败',
  unsubscribed: '已退订',
  skipped: '未使用',
}

const EVIDENCE_LABELS: Record<Evidence['category'], string> = {
  timeout: '通道无响应',
  'channel-error': '通道报错',
  'stale-duplicate': '回放旧消息',
  'retry-exhausted': '重试超限',
  unsubscribed: '渠道退订',
  'no-channel': '无可达渠道',
  'residual-cleanup': '残留清理',
}

export function batchStatusLabel(status: Batch['status']): string {
  return STATUS_LABELS[status]
}

export function deliveryStateLabel(state: Delivery['state']): string {
  return DELIVERY_LABELS[state]
}

export function channelStateLabel(state: ChannelDelivery['state']): string {
  return CHANNEL_STATE_LABELS[state]
}

export function evidenceCategoryLabel(category: Evidence['category']): string {
  return EVIDENCE_LABELS[category]
}

export function pluralChannels(channels: Channel[]): string {
  return channels.length > 0 ? channels.map((channel) => CHANNEL_LABELS[channel]).join('、') : '—'
}

export function renderBatchCsv(state: NotifyState): string {
  const header = [
    '批次编号',
    '消息类型',
    '规则',
    '状态',
    '接收人',
    '接收人状态',
    '重试次数',
    '重试上限',
    '送达渠道',
    '回执编号',
    '备注',
  ]
  const lines = [header.join(',')]
  for (const batch of state.batches) {
    for (const delivery of batch.deliveries) {
      const receipt = delivery.deliveredChannel
        ? state.receipts.find(
            (item) =>
              item.batchId === batch.id &&
              item.recipientId === delivery.recipientId &&
              item.channel === delivery.deliveredChannel,
          )
        : undefined
      lines.push(
        [
          batch.code,
          CLASS_LABELS[batch.messageClass],
          batch.resolution.winnerRuleCode,
          STATUS_LABELS[batch.status],
          delivery.recipientName,
          DELIVERY_LABELS[delivery.state],
          delivery.attempts,
          delivery.maxRetries,
          delivery.deliveredChannel ? CHANNEL_LABELS[delivery.deliveredChannel] : '',
          receipt?.id ?? '',
          delivery.note ?? '',
        ].join(','),
      )
    }
  }
  return lines.join('\n')
}

export function renderEvidenceCsv(state: NotifyState): string {
  const header = ['旁证编号', '批次', '接收人', '渠道', '类别', '说明', '尝试次数', '时间']
  const lines = [header.join(',')]
  for (const evidence of state.evidence) {
    lines.push(
      [
        evidence.id,
        evidence.batchCode,
        evidence.recipientName ?? '',
        evidence.channel ? CHANNEL_LABELS[evidence.channel] : '',
        EVIDENCE_LABELS[evidence.category],
        evidence.detail,
        evidence.attempts ?? '',
        new Date(evidence.at).toLocaleString('zh-CN'),
      ].join(','),
    )
  }
  return lines.join('\n')
}
