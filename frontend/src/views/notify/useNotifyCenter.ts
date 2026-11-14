import { useCallback, useState } from 'react'

import {
  abandonCenter,
  applyIncidentCenter,
  cleanupAll,
  cleanupBatch,
  downloadCsv,
  exportBatches,
  exportEvidence,
  interruptCenter,
  loadCenter,
  probeCenter,
  resetCenter,
  residualCenter,
  resumeCenter,
  retryCenter,
  sendCenter,
  toggleCenterRule,
  triggerCenter,
  updateChannelHealth,
  updateRecipientFault,
} from '@/api/notify-service'
import type {
  Channel,
  ChannelHealthState,
  NotifyState,
  OperationResult,
  TriggerInput,
  TriggerResult,
} from '@/domain/notify/types'

type Outcome = { state: NotifyState; result: OperationResult }

/** 所有领域动作返回新状态；数据服务负责落盘，这里只负责把结果交给页面。 */
export function useNotifyCenter() {
  const [state, setState] = useState<NotifyState>(() => loadCenter())
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const commit = useCallback((outcome: Outcome) => {
    setState(outcome.state)
    setMessage({ ok: outcome.result.ok, text: outcome.result.message })
    return outcome.result
  }, [])

  const notify = useCallback((ok: boolean, text: string) => setMessage({ ok, text }), [])

  const trigger = useCallback(
    (input: TriggerInput): TriggerResult => {
      const outcome = triggerCenter(state, input)
      setState(outcome.state)
      setMessage({ ok: outcome.result.ok, text: outcome.result.message })
      return outcome.result
    },
    [state],
  )

  const send = useCallback(
    (batchId: number, limit?: number) => commit(sendCenter(state, batchId, limit)),
    [commit, state],
  )
  const resume = useCallback((batchId: number) => commit(resumeCenter(state, batchId)), [commit, state])
  const abandon = useCallback((batchId: number) => commit(abandonCenter(state, batchId)), [commit, state])
  const retry = useCallback((batchId: number) => commit(retryCenter(state, batchId)), [commit, state])
  const interrupt = useCallback((batchId: number) => commit(interruptCenter(state, batchId)), [commit, state])
  const cleanup = useCallback((batchId: number) => commit(cleanupBatch(state, batchId)), [commit, state])
  const cleanupAllResidual = useCallback(() => commit(cleanupAll(state)), [commit, state])
  const applyIncident = useCallback(() => commit(applyIncidentCenter(state)), [commit, state])
  const probe = useCallback(
    (channel: Channel) => {
      const result = probeCenter(state, channel)
      setMessage({ ok: result.ok, text: result.message })
      return result
    },
    [state],
  )
  const setHealth = useCallback(
    (channel: Channel, health: ChannelHealthState) => commit(updateChannelHealth(state, channel, health)),
    [commit, state],
  )
  const setFault = useCallback(
    (recipientId: string, health: ChannelHealthState | 'none') => commit(updateRecipientFault(state, recipientId, health)),
    [commit, state],
  )
  const toggle = useCallback((ruleId: number) => commit(toggleCenterRule(state, ruleId)), [commit, state])
  const reset = useCallback(() => {
    const fresh = resetCenter()
    setState(fresh)
    setMessage({ ok: true, text: '送达中心已恢复为示例数据' })
  }, [])

  const downloadBatches = useCallback(() => {
    const { filename, content } = exportBatches(state)
    downloadCsv(filename, content)
  }, [state])

  const downloadEvidence = useCallback(() => {
    const { filename, content } = exportEvidence(state)
    downloadCsv(filename, content)
  }, [state])

  return {
    state,
    message,
    dismissMessage: () => setMessage(null),
    notify,
    trigger,
    send,
    resume,
    abandon,
    retry,
    interrupt,
    cleanup,
    cleanupAllResidual,
    applyIncident,
    probe,
    setHealth,
    setFault,
    toggle,
    reset,
    downloadBatches,
    downloadEvidence,
    residuals: residualCenter(state),
  }
}
