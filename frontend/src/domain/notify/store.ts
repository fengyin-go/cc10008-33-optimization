import { createInitialState } from './engine'
import type { NotifyState } from './types'

/** 送达中心单独一个存储键：与登记表的示例数据互不覆盖。 */
export const NOTIFY_STORAGE_KEY = 'interactive-analytics-lab:notify-center'

function normalize(raw: unknown): NotifyState {
  const base = createInitialState()
  if (!raw || typeof raw !== 'object') return base
  const parsed = raw as Partial<NotifyState>
  if (parsed.version !== 1) return base
  return {
    ...base,
    ...parsed,
    channelHealth: { ...base.channelHealth, ...(parsed.channelHealth ?? {}) },
    faultInjections: parsed.faultInjections ?? {},
    batches: Array.isArray(parsed.batches)
      ? parsed.batches.map((batch) => ({ ...batch, alertAt: batch.alertAt ?? batch.createdAt }))
      : [],
    receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
    rules: Array.isArray(parsed.rules) ? parsed.rules : base.rules,
    recipients: Array.isArray(parsed.recipients) ? parsed.recipients : base.recipients,
    seq: typeof parsed.seq === 'number' ? parsed.seq : 0,
  }
}

export function loadNotifyState(): NotifyState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return createInitialState()
  }
  const raw = window.localStorage.getItem(NOTIFY_STORAGE_KEY)
  if (!raw) return createInitialState()
  try {
    return normalize(JSON.parse(raw))
  } catch {
    return createInitialState()
  }
}

export function saveNotifyState(state: NotifyState): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  window.localStorage.setItem(NOTIFY_STORAGE_KEY, JSON.stringify(state))
}

