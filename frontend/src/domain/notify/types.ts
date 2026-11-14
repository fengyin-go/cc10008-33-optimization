/**
 * 通知送达中心的领域类型。
 *
 * 与 src/data/types.ts 的通用登记表分开：登记表只描述"规则长什么样"，
 * 批次、接收人、回执、失败旁证属于送达过程，需要按接收人逐条落账。
 */

export type Channel = 'email' | 'im' | 'sms' | 'webhook'
export type ChannelHealthState = 'healthy' | 'unresponsive' | 'erroring' | 'stale-echo'
export type MessageClass = 'alert' | 'report'
export type ListMode = 'union' | 'intersection'
/** 同优先级但接收列表不同时如何决定发出对象。 */
export type ConflictPolicy = 'priority-wins' | 'merge-lists'

export type BatchStatus =
  | 'pending'
  | 'sending'
  | 'paused'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cleaned'

export type RecipientDeliveryState = 'pending' | 'delivered' | 'failed' | 'skipped'
export type ChannelDeliveryState =
  | 'pending'
  | 'sent'
  | 'failed'
  | 'unsubscribed'
  | 'skipped'

export type Recipient = {
  id: string
  name: string
  dept: string
  channels: Channel[]
  /** 按渠道退订：退订 email 不影响同一接收人的 im / sms。 */
  unsubscribed: Channel[]
}

export type RuleStatus = '草稿' | '待校验' | '已启用' | '已停用'

export type NotifyRule = {
  id: number
  code: string
  name: string
  messageClass: MessageClass
  trigger: string
  priority: number
  /** 登记顺序；优先级相同时，编号小者优先（明确的最终裁决）。 */
  order: number
  channels: Channel[]
  recipients: string[]
  mergeWindowSec: number
  maxRetries: number
  status: RuleStatus
}

export type ResolutionContribution = {
  ruleCode: string
  ruleName: string
  priority: number
  order: number
  recipients: string[]
}

export type Resolution = {
  mode: ListMode
  conflict: boolean
  conflictPolicy: ConflictPolicy
  winnerRuleCode: string
  winnerRuleName: string
  tieBreakReason: string
  contributions: ResolutionContribution[]
  ruleIds: number[]
  recipientIds: string[]
  excludedRecipientIds: string[]
  explanation: string
}

export type ChannelDelivery = {
  channel: Channel
  state: ChannelDeliveryState
  attempts: number
  lastError?: string
  receiptId?: string
  sentAt?: number
  supersededBy?: Channel
}

export type Delivery = {
  recipientId: string
  recipientName: string
  state: RecipientDeliveryState
  /** 接收人维度的失败重试次数：每个接收人单独计数。 */
  attempts: number
  maxRetries: number
  channels: ChannelDelivery[]
  deliveredChannel?: Channel
  note?: string
}

export type BatchEvent = { at: number; trigger: string; note?: string }

export type CleanupRecord = {
  at: number
  droppedDeliveries: number
  keptReceipts: number
  keptEvidence: number
  reason: string
}

export type Batch = {
  id: number
  code: string
  messageClass: MessageClass
  title: string
  trigger: string
  createdAt: number
  updatedAt: number
  /** 最近一次告警发生（创建或合并）的时间；发送动作不会推进它。 */
  alertAt: number
  status: BatchStatus
  mergeKey: string
  mergeWindowSec: number
  mergedCount: number
  events: BatchEvent[]
  resolution: Resolution
  maxRetries: number
  deliveries: Delivery[]
  /** 下一个待处理接收人的下标：中断后续发从这里开始。 */
  cursor: number
  resumeNote?: string
  cleanup?: CleanupRecord
}

export type Receipt = {
  id: string
  batchId: number
  batchCode: string
  messageClass: MessageClass
  recipientId: string
  recipientName: string
  channel: Channel
  sentAt: number
}

export type EvidenceCategory =
  | 'timeout'
  | 'channel-error'
  | 'stale-duplicate'
  | 'retry-exhausted'
  | 'unsubscribed'
  | 'no-channel'
  | 'residual-cleanup'

export type Evidence = {
  id: string
  batchId: number
  batchCode: string
  recipientId?: string
  recipientName?: string
  channel?: Channel
  category: EvidenceCategory
  detail: string
  attempts?: number
  at: number
}

export type ChannelHealth = {
  channel: Channel
  state: ChannelHealthState
  lastError?: string
  lastFailureAt?: number
  successCount: number
  failureCount: number
  staleCount: number
  duplicateCount: number
}

export type NotifyState = {
  version: 1
  rules: NotifyRule[]
  recipients: Recipient[]
  channelHealth: Record<Channel, ChannelHealth>
  /** 故障注入：只影响指定接收人，用于验证单人的重试与旁证，不污染整个通道。 */
  faultInjections: Record<string, ChannelHealthState>
  batches: Batch[]
  receipts: Receipt[]
  evidence: Evidence[]
  seq: number
  updatedAt: number
}

export type TriggerInput = {
  ruleIds: number[]
  listMode: ListMode
  conflictPolicy: ConflictPolicy
  trigger: string
  note?: string
  now?: number
}

export type TriggerResult = {
  ok: boolean
  message: string
  createdCodes: string[]
  mergedCodes: string[]
  createdIds: number[]
}

export type OperationResult = {
  ok: boolean
  message: string
}

export type ResidualFinding = {
  batch: Batch
  reason: string
  severity: 'high' | 'medium'
  pendingRecipients: string[]
  ageMs: number
}
