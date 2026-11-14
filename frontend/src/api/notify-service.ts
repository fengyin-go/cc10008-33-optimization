import {
  abandonCurrentRecipient,
  applyChannelIncident,
  cleanupAllResidual,
  cleanupResidualBatch,
  createInitialState,
  exhaustRetries,
  findResidualBatches,
  probeChannel,
  renderBatchCsv,
  renderEvidenceCsv,
  resumeBatch,
  sendBatch,
  setChannelHealth,
  setRecipientFault,
  simulateInterrupt,
  toggleRule,
  triggerNotification,
} from '@/domain/notify/engine'
import { loadNotifyState, saveNotifyState } from '@/domain/notify/store'
import type {
  Channel,
  ChannelHealthState,
  NotifyState,
  OperationResult,
  TriggerInput,
  TriggerResult,
} from '@/domain/notify/types'

// 通知送达中心的数据服务：页面只调这里，状态落盘也集中在这里。
// 通用登记表（规则长什么样）仍归 local-service.ts；送达过程（批次/回执/旁证）归本文件。

export type NotifyOutcome = { state: NotifyState; result: OperationResult }

function persist(state: NotifyState): NotifyState {
  saveNotifyState(state)
  return state
}

export function loadCenter(): NotifyState {
  return loadNotifyState()
}

export function triggerCenter(state: NotifyState, input: TriggerInput): { state: NotifyState; result: TriggerResult } {
  const outcome = triggerNotification(state, input)
  persist(outcome.state)
  return outcome
}

export function sendCenter(state: NotifyState, batchId: number, limit?: number): NotifyOutcome {
  const outcome = sendBatch(state, batchId, { limit })
  persist(outcome.state)
  return outcome
}

export function resumeCenter(state: NotifyState, batchId: number): NotifyOutcome {
  const outcome = resumeBatch(state, batchId)
  persist(outcome.state)
  return outcome
}

export function abandonCenter(state: NotifyState, batchId: number): NotifyOutcome {
  const outcome = abandonCurrentRecipient(state, batchId)
  persist(outcome.state)
  return outcome
}

export function retryCenter(state: NotifyState, batchId: number): NotifyOutcome {
  const outcome = exhaustRetries(state, batchId)
  persist(outcome.state)
  return outcome
}

export function interruptCenter(state: NotifyState, batchId: number): NotifyOutcome {
  const outcome = simulateInterrupt(state, batchId)
  persist(outcome.state)
  return outcome
}

export function cleanupBatch(state: NotifyState, batchId: number): NotifyOutcome {
  const outcome = cleanupResidualBatch(state, batchId)
  persist(outcome.state)
  return outcome
}

export function cleanupAll(state: NotifyState): NotifyOutcome {
  const outcome = cleanupAllResidual(state)
  persist(outcome.state)
  return outcome
}

export function probeCenter(state: NotifyState, channel: Channel): OperationResult {
  return probeChannel(state, channel)
}

export function applyIncidentCenter(state: NotifyState): NotifyOutcome {
  const outcome = applyChannelIncident(state)
  persist(outcome.state)
  return outcome
}

export function updateChannelHealth(
  state: NotifyState,
  channel: Channel,
  health: ChannelHealthState,
): NotifyOutcome {
  const outcome = setChannelHealth(state, channel, health)
  persist(outcome.state)
  return outcome
}

export function updateRecipientFault(
  state: NotifyState,
  recipientId: string,
  health: ChannelHealthState | 'none',
): NotifyOutcome {
  const outcome = setRecipientFault(state, recipientId, health)
  persist(outcome.state)
  return outcome
}

export function toggleCenterRule(state: NotifyState, ruleId: number): NotifyOutcome {
  const outcome = toggleRule(state, ruleId)
  persist(outcome.state)
  return outcome
}

export function residualCenter(state: NotifyState) {
  return findResidualBatches(state)
}

export function resetCenter(): NotifyState {
  return persist(createInitialState())
}

export function exportBatches(state: NotifyState): { filename: string; content: string } {
  return { filename: '通知送达批次.csv', content: `﻿${renderBatchCsv(state)}` }
}

export function exportEvidence(state: NotifyState): { filename: string; content: string } {
  return { filename: '通知失败旁证.csv', content: `﻿${renderEvidenceCsv(state)}` }
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
