import { useMemo, useState } from 'react'

import {
  CHANNEL_LABELS,
  HEALTH_LABELS,
  batchStats,
  channelStateLabel,
  deliveryStateLabel,
  evidenceCategoryLabel,
  lastAlertActivity,
  pluralChannels,
  resolveRules,
} from '@/domain/notify/engine'
import type {
  Batch,
  Channel,
  ChannelHealthState,
  ConflictPolicy,
  Delivery,
  ListMode,
  NotifyRule,
  Recipient,
} from '@/domain/notify/types'

import { useNotifyCenter } from './useNotifyCenter'

const ALL_CHANNELS: Channel[] = ['email', 'im', 'sms', 'webhook']
const FAULT_OPTIONS: ChannelHealthState[] = ['healthy', 'unresponsive', 'erroring', 'stale-echo']

function formatTime(value?: number): string {
  if (!value) return '—'
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
}

function formatAge(ms: number): string {
  if (ms < 1000) return '刚刚'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时`
}

const BATCH_STATUS_TEXT: Record<Batch['status'], string> = {
  pending: '待发送',
  sending: '发送中',
  paused: '已暂停',
  completed: '已全部送达',
  partial: '部分送达',
  failed: '已失败',
  cleaned: '已清理',
}

const CLASS_TEXT: Record<NotifyRule['messageClass'], string> = {
  alert: '普通告警',
  report: '定时报告',
}

function StatusPill({ kind, text }: { kind: string; text: string }) {
  return <span className={`pill pill-${kind}`}>{text}</span>
}

function batchPillKind(status: Batch['status']): string {
  if (status === 'completed') return 'ok'
  if (status === 'partial') return 'warn'
  if (status === 'failed') return 'bad'
  if (status === 'sending') return 'info'
  if (status === 'paused') return 'warn'
  if (status === 'cleaned') return 'muted'
  return 'neutral'
}

function deliveryPillKind(state: Delivery['state']): string {
  if (state === 'delivered') return 'ok'
  if (state === 'failed') return 'bad'
  if (state === 'skipped') return 'muted'
  return 'neutral'
}

export default function NotifyView() {
  const center = useNotifyCenter()
  const { state } = center

  const [selectedRuleIds, setSelectedRuleIds] = useState<number[]>([1, 2, 3])
  const [listMode, setListMode] = useState<ListMode>('union')
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>('priority-wins')
  const [eventLabel, setEventLabel] = useState('卡点异常')
  const [tab, setTab] = useState<'batches' | 'receipts' | 'evidence' | 'matrix'>('batches')
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null)
  const [faultRecipientId, setFaultRecipientId] = useState('u-li')
  const [faultState, setFaultState] = useState<ChannelHealthState | 'none'>('unresponsive')
  const [ledgerFilter, setLedgerFilter] = useState('')

  const selectedRules = useMemo(
    () => state.rules.filter((rule) => selectedRuleIds.includes(rule.id)),
    [selectedRuleIds, state.rules],
  )
  const preview = useMemo(
    () => resolveRules(selectedRules, listMode, conflictPolicy, state.recipients),
    [conflictPolicy, listMode, selectedRules, state.recipients],
  )
  const stats = useMemo(() => batchStats(state), [state])
  const selectedBatch = state.batches.find((batch) => batch.id === selectedBatchId) ?? null
  const nameOf = (id: string) => state.recipients.find((item) => item.id === id)?.name ?? id

  function toggleRuleSelection(ruleId: number) {
    setSelectedRuleIds((prev) => (prev.includes(ruleId) ? prev.filter((id) => id !== ruleId) : [...prev, ruleId]))
  }

  function fire() {
    const result = center.trigger({
      ruleIds: selectedRuleIds,
      listMode,
      conflictPolicy,
      trigger: eventLabel.trim() || '未命名事件',
    })
    if (result.ok && result.createdIds.length > 0) {
      setSelectedBatchId(result.createdIds[result.createdIds.length - 1])
      setTab('batches')
    }
  }

  function fireLate() {
    // 把"现在"推到所有告警窗口之外，专门验证窗口过期后应新建批次。
    const alarmBatches = state.batches.filter((batch) => batch.messageClass === 'alert')
    const anchor = alarmBatches.reduce((max, batch) => Math.max(max, lastAlertActivity(batch)), Date.now() - 60_000)
    const windowMs = Math.max(1, ...alarmBatches.map((batch) => batch.mergeWindowSec)) * 1000
    const result = center.trigger({
      ruleIds: selectedRuleIds.filter((id) => state.rules.find((rule) => rule.id === id)?.messageClass === 'alert'),
      listMode,
      conflictPolicy,
      trigger: eventLabel.trim() || '未命名事件',
      now: anchor + windowMs + 1000,
    })
    if (result.ok) {
      setTab('batches')
    }
  }

  function clearSelection() {
    setSelectedRuleIds([])
  }

  const alertRules = state.rules.filter((rule) => rule.messageClass === 'alert')
  const reportRules = state.rules.filter((rule) => rule.messageClass === 'report')

  const ledgerReceipts = state.receipts.filter((receipt) =>
    ledgerFilter.trim() === '' ? true : `${receipt.batchCode} ${receipt.recipientName} ${receipt.id}`.includes(ledgerFilter.trim()),
  )
  const ledgerEvidence = state.evidence.filter((evidence) =>
    ledgerFilter.trim() === ''
      ? true
      : `${evidence.batchCode} ${evidence.recipientName ?? ''} ${evidence.detail}`.includes(ledgerFilter.trim()),
  )

  return (
    <section className="page notify-page" data-module="notify">
      <header className="page-head">
        <div>
          <h2>通知送达中心</h2>
          <p className="page-desc">
            告警与报告分别形成通知批次；告警按合并窗口抑制重复，报告保留独立标识与送达记录。所有发送按接收人逐条落账，
            成功回执与失败旁证同时保留。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={center.downloadBatches}>导出批次清单</button>
          <button className="btn" type="button" onClick={center.downloadEvidence}>导出失败旁证</button>
          <button className="btn ghost" type="button" onClick={center.reset}>恢复示例数据</button>
        </div>
      </header>

      {center.message && (
        <div className={`notice ${center.message.ok ? 'notice-ok' : 'notice-bad'}`} role="status">
          <span>{center.message.text}</span>
          <button className="link" type="button" onClick={center.dismissMessage}>关闭</button>
        </div>
      )}

      <div className="stat-row">
        <article className="stat-card"><span className="stat-label">告警批次</span><strong className="stat-value">{stats.alertBatches}</strong></article>
        <article className="stat-card"><span className="stat-label">报告批次</span><strong className="stat-value">{stats.reportBatches}</strong></article>
        <article className="stat-card"><span className="stat-label">成功回执</span><strong className="stat-value">{stats.receipts}</strong></article>
        <article className="stat-card"><span className="stat-label">失败旁证</span><strong className="stat-value">{stats.evidence}</strong></article>
        <article className="stat-card"><span className="stat-label">被抑制告警</span><strong className="stat-value">{stats.merged}</strong></article>
        <article className="stat-card"><span className="stat-label">待重试接收人</span><strong className="stat-value">{stats.pendingRetries}</strong></article>
        <article className="stat-card"><span className="stat-label">残留批次</span><strong className="stat-value">{stats.residual}</strong></article>
      </div>

      <div className="notify-grid">
        {/* ------------------------------ 触发控制台 ------------------------------ */}
        <article className="panel panel-trigger">
          <header className="panel-head">
            <h3>触发通知</h3>
            <span className="panel-hint">告警与报告自动分组，各成批次</span>
          </header>

          <div className="field">
            <label htmlFor="event-label">触发事件</label>
            <input id="event-label" value={eventLabel} onChange={(event) => setEventLabel(event.target.value)} />
            <p className="field-hint">同类型告警使用同一事件标识时才进入合并窗口；报告永远新开批次。</p>
          </div>

          <div className="rule-picker">
            <p className="picker-title">普通告警规则</p>
            {alertRules.map((rule) => (
              <label key={rule.id} className={`rule-option ${rule.status !== '已启用' ? 'rule-off' : ''}`}>
                <input
                  type="checkbox"
                  checked={selectedRuleIds.includes(rule.id)}
                  onChange={() => toggleRuleSelection(rule.id)}
                />
                <span className="rule-code">{rule.code}</span>
                <span className="rule-name">{rule.name}</span>
                <span className="rule-meta">优先级 {rule.priority} · 登记 {rule.order} · 窗口 {rule.mergeWindowSec}s</span>
                {rule.status !== '已启用' && <StatusPill kind="muted" text={rule.status} />}
              </label>
            ))}
            <p className="picker-title">定时报告规则</p>
            {reportRules.map((rule) => (
              <label key={rule.id} className={`rule-option ${rule.status !== '已启用' ? 'rule-off' : ''}`}>
                <input
                  type="checkbox"
                  checked={selectedRuleIds.includes(rule.id)}
                  onChange={() => toggleRuleSelection(rule.id)}
                />
                <span className="rule-code">{rule.code}</span>
                <span className="rule-name">{rule.name}</span>
                <span className="rule-meta">优先级 {rule.priority} · 登记 {rule.order} · 独立批次</span>
                {rule.status !== '已启用' && <StatusPill kind="muted" text={rule.status} />}
              </label>
            ))}
          </div>

          <div className="control-row">
            <span className="control-label">接收列表算法</span>
            <div className="segmented">
              <button type="button" className={listMode === 'union' ? 'seg active' : 'seg'} onClick={() => setListMode('union')}>并集</button>
              <button type="button" className={listMode === 'intersection' ? 'seg active' : 'seg'} onClick={() => setListMode('intersection')}>交集</button>
            </div>
          </div>
          <p className="field-hint">
            {listMode === 'union'
              ? '并集：选中规则里出现过的接收人全部纳入，按人去重，适合覆盖面优先的告警。'
              : '交集：只给同时出现在每条选中规则里的接收人发送，适合只通知共同值班人。'}
          </p>

          {preview.conflict && (
            <>
              <div className="control-row">
                <span className="control-label">优先级冲突裁决</span>
                <div className="segmented">
                  <button type="button" className={conflictPolicy === 'priority-wins' ? 'seg active' : 'seg'} onClick={() => setConflictPolicy('priority-wins')}>明确规则裁决</button>
                  <button type="button" className={conflictPolicy === 'merge-lists' ? 'seg active' : 'seg'} onClick={() => setConflictPolicy('merge-lists')}>合并双方名单</button>
                </div>
              </div>
              <div className="conflict-box">
                <strong>检测到同优先级冲突</strong>
                <p>{preview.tieBreakReason}</p>
                <p>
                  胜出规则 <b>{preview.winnerRuleCode}</b>「{preview.winnerRuleName}」。
                  当前策略发出的接收对象：{preview.recipientIds.map(nameOf).join('、') || '无'}。
                </p>
              </div>
            </>
          )}

          <div className="preview-box">
            <p className="preview-title">接收人预览（{preview.recipientIds.length} 位）</p>
            <div className="chip-row">
              {preview.recipientIds.length === 0 && <span className="field-hint">没有符合条件的接收人</span>}
              {preview.recipientIds.map((id) => (
                <span key={id} className="chip">{nameOf(id)}</span>
              ))}
            </div>
            {listMode === 'intersection' && preview.excludedRecipientIds.length > 0 && (
              <p className="field-hint">被交集排除：{preview.excludedRecipientIds.map(nameOf).join('、')}</p>
            )}
            <p className="field-hint">{preview.explanation}</p>
          </div>

          <div className="trigger-actions">
            <button className="btn primary" type="button" onClick={fire}>触发通知</button>
            <button className="btn" type="button" onClick={fireLate}>窗口外重复告警</button>
            <button className="btn ghost" type="button" onClick={clearSelection}>清空选择</button>
          </div>
          <p className="field-hint">
            「窗口外重复告警」把本次触发时间推到窗口之后，用于验证告警窗口过期后应新建批次，而不是继续抑制。
          </p>
        </article>

        {/* ------------------------------ 通道健康 ------------------------------ */}
        <article className="panel">
          <header className="panel-head">
            <h3>通道健康与故障定位</h3>
            <div className="panel-actions">
              <span className="panel-hint">失败只影响使用该通道的接收人</span>
              <button className="btn" type="button" onClick={center.applyIncident}>注入故障场景</button>
            </div>
          </header>
          <div className="channel-list">
            {ALL_CHANNELS.map((channel) => {
              const health = state.channelHealth[channel]
              const healthKind = health.state === 'healthy' ? 'ok' : health.state === 'erroring' ? 'bad' : 'warn'
              return (
                <div key={channel} className="channel-card">
                  <div className="channel-head">
                    <strong>{CHANNEL_LABELS[channel]}</strong>
                    <StatusPill kind={healthKind} text={HEALTH_LABELS[health.state]} />
                  </div>
                  {health.lastError && <p className="channel-error">{health.lastError}</p>}
                  <p className="channel-counts">
                    成功 {health.successCount} · 失败 {health.failureCount} · 回放 {health.staleCount}
                  </p>
                  <div className="channel-actions">
                    <button className="link" type="button" onClick={() => center.probe(channel)}>探测</button>
                    {health.state !== 'healthy' && (
                      <button className="link" type="button" onClick={() => center.setHealth(channel, 'healthy')}>标记修复</button>
                    )}
                    <select
                      className="mini-select"
                      value=""
                      onChange={(event) => {
                        const value = event.target.value as ChannelHealthState
                        if (value) center.setHealth(channel, value)
                        event.target.value = ''
                      }}
                    >
                      <option value="">设为故障…</option>
                      {FAULT_OPTIONS.filter((option) => option !== 'healthy').map((option) => (
                        <option key={option} value={option}>{HEALTH_LABELS[option]}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="fault-injector">
            <p className="picker-title">单人故障注入（验证按接收人独立重试）</p>
            <div className="inline-form">
              <select value={faultRecipientId} onChange={(event) => setFaultRecipientId(event.target.value)}>
                {state.recipients.map((recipient) => (
                  <option key={recipient.id} value={recipient.id}>{recipient.name}</option>
                ))}
              </select>
              <select value={faultState} onChange={(event) => setFaultState(event.target.value as ChannelHealthState | 'none')}>
                <option value="none">无故障</option>
                {FAULT_OPTIONS.filter((option) => option !== 'healthy').map((option) => (
                  <option key={option} value={option}>{HEALTH_LABELS[option]}</option>
                ))}
              </select>
              <button className="btn" type="button" onClick={() => center.setFault(faultRecipientId, faultState)}>应用</button>
            </div>
            <p className="field-hint">
              当前注入：{Object.keys(state.faultInjections).length === 0
                ? '无'
                : Object.entries(state.faultInjections).map(([id, kind]) => `${nameOf(id)}=${HEALTH_LABELS[kind]}`).join('、')}
              。注入只针对该接收人，不会把整个通道标成故障，因此同一批次里的其他人照常送达。
            </p>
            <p className="field-hint">
              发送规则：单个接收人的失败次数单独计数，超过「重试上限」后才转入失败旁证并继续下一位；
              批次在未达上限时暂停，续发从最后失败的那位接收人开始，已送达的人不会再收到第二次。
            </p>
          </div>
        </article>
      </div>

      {/* ------------------------------ 残留批次 ------------------------------ */}
      <article className="panel">
        <header className="panel-head">
          <h3>残留批次定位</h3>
          <div className="panel-actions">
            <span className="panel-hint">发送中断、停在失败接收人或窗口过期未发的批次</span>
            <button className="btn" type="button" onClick={center.cleanupAllResidual} disabled={center.residuals.length === 0}>全部清理</button>
          </div>
        </header>
        {center.residuals.length === 0 ? (
          <p className="empty-line">没有发现残留批次。发送中断或暂停的批次会自动出现在这里。</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr><th>批次</th><th>类型</th><th>状态</th><th>残留原因</th><th>待处理接收人</th><th>停留时长</th><th>处置</th></tr>
            </thead>
            <tbody>
              {center.residuals.map((finding) => (
                <tr key={finding.batch.id}>
                  <td>{finding.batch.code}</td>
                  <td>{CLASS_TEXT[finding.batch.messageClass]}</td>
                  <td><StatusPill kind={batchPillKind(finding.batch.status)} text={BATCH_STATUS_TEXT[finding.batch.status]} /></td>
                  <td>
                    <StatusPill kind={finding.severity === 'high' ? 'bad' : 'warn'} text={finding.severity === 'high' ? '高' : '中'} />
                    {finding.reason}
                  </td>
                  <td>{finding.pendingRecipients.join('、') || '—'}</td>
                  <td>{formatAge(finding.ageMs)}</td>
                  <td className="row-actions">
                    <button className="link" type="button" onClick={() => center.resume(finding.batch.id)}>续发</button>
                    <button className="link danger" type="button" onClick={() => center.cleanup(finding.batch.id)}>清理</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </article>

      {/* ------------------------------ 台账标签页 ------------------------------ */}
      <article className="panel">
        <header className="panel-head">
          <h3>送达台账</h3>
          <div className="ledger-tools">
            <div className="segmented">
              <button type="button" className={tab === 'batches' ? 'seg active' : 'seg'} onClick={() => setTab('batches')}>批次 {state.batches.length}</button>
              <button type="button" className={tab === 'receipts' ? 'seg active' : 'seg'} onClick={() => setTab('receipts')}>成功回执 {state.receipts.length}</button>
              <button type="button" className={tab === 'evidence' ? 'seg active' : 'seg'} onClick={() => setTab('evidence')}>失败旁证 {state.evidence.length}</button>
              <button type="button" className={tab === 'matrix' ? 'seg active' : 'seg'} onClick={() => setTab('matrix')}>接收人矩阵</button>
            </div>
            {tab !== 'batches' && tab !== 'matrix' && (
              <input
                className="ledger-filter"
                value={ledgerFilter}
                placeholder="按批次、接收人或编号检索"
                onChange={(event) => setLedgerFilter(event.target.value)}
              />
            )}
          </div>
        </header>

        {tab === 'batches' && (
          <>
            <table className="data-table">
              <thead>
                <tr>
                  <th>批次</th><th>类型</th><th>胜出规则</th><th>状态</th><th>合并次数 / 窗口</th>
                  <th>接收人进度</th><th>重试上限</th><th>更新时间</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {state.batches.length === 0 && (
                  <tr><td colSpan={9} className="empty-state">还没有通知批次，先在左侧选择规则并触发</td></tr>
                )}
                {state.batches.map((batch) => {
                  const delivered = batch.deliveries.filter((delivery) => delivery.state === 'delivered').length
                  const failed = batch.deliveries.filter((delivery) => delivery.state === 'failed').length
                  const skipped = batch.deliveries.filter((delivery) => delivery.state === 'skipped').length
                  const closed = batch.status === 'cleaned' || batch.status === 'completed' || batch.status === 'failed'
                  return (
                    <tr key={batch.id} className={selectedBatchId === batch.id ? 'row-selected' : ''}>
                      <td>
                        <button className="link code-link" type="button" onClick={() => setSelectedBatchId(batch.id)}>{batch.code}</button>
                        {batch.mergedCount > 0 && <span className="merge-badge">合并×{batch.mergedCount}</span>}
                      </td>
                      <td><StatusPill kind={batch.messageClass === 'alert' ? 'warn' : 'info'} text={CLASS_TEXT[batch.messageClass]} /></td>
                      <td>{batch.resolution.winnerRuleCode}「{batch.resolution.winnerRuleName}」</td>
                      <td><StatusPill kind={batchPillKind(batch.status)} text={BATCH_STATUS_TEXT[batch.status]} /></td>
                      <td>{batch.mergedCount} 次 · {batch.mergeWindowSec}s</td>
                      <td>送达 {delivered} / 失败 {failed} / 跳过 {skipped} / 共 {batch.deliveries.length}</td>
                      <td>{batch.maxRetries} 次</td>
                      <td>{formatTime(batch.updatedAt)}</td>
                      <td className="row-actions">
                        {!closed && batch.status !== 'sending' && (
                          <>
                            <button className="link" type="button" onClick={() => center.send(batch.id)}>发送</button>
                            <button className="link" type="button" onClick={() => center.send(batch.id, 1)}>单步</button>
                          </>
                        )}
                        {batch.status === 'paused' && (
                          <>
                            <button className="link" type="button" onClick={() => center.resume(batch.id)}>续发</button>
                            <button className="link" type="button" onClick={() => center.retry(batch.id)}>重试到上限</button>
                            <button className="link" type="button" onClick={() => center.abandon(batch.id)}>放弃当前</button>
                          </>
                        )}
                        {batch.status === 'sending' && (
                          <button className="link" type="button" onClick={() => center.resume(batch.id)}>从断点续发</button>
                        )}
                        {!closed && <button className="link" type="button" onClick={() => center.interrupt(batch.id)}>模拟中断</button>}
                        {batch.status !== 'cleaned' && (
                          <button className="link danger" type="button" onClick={() => center.cleanup(batch.id)}>清理</button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {selectedBatch ? <BatchDetail batch={selectedBatch} state={state} onClose={() => setSelectedBatchId(null)} /> : (
              <p className="field-hint">点批次编号查看接收人逐条回执、渠道尝试次数与事件时间线。</p>
            )}
          </>
        )}

        {tab === 'receipts' && (
          <table className="data-table">
            <thead>
              <tr><th>回执编号</th><th>批次</th><th>消息类型</th><th>接收人</th><th>渠道</th><th>送达时间</th></tr>
            </thead>
            <tbody>
              {ledgerReceipts.length === 0 && <tr><td colSpan={6} className="empty-state">暂无成功回执</td></tr>}
              {ledgerReceipts.map((receipt) => (
                <tr key={receipt.id}>
                  <td>{receipt.id}</td>
                  <td>{receipt.batchCode}</td>
                  <td><StatusPill kind={receipt.messageClass === 'alert' ? 'warn' : 'info'} text={CLASS_TEXT[receipt.messageClass]} /></td>
                  <td>{receipt.recipientName}</td>
                  <td>{CHANNEL_LABELS[receipt.channel]}</td>
                  <td>{formatTime(receipt.sentAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'evidence' && (
          <table className="data-table">
            <thead>
              <tr><th>旁证编号</th><th>批次</th><th>接收人</th><th>渠道</th><th>类别</th><th>说明</th><th>尝试</th><th>时间</th></tr>
            </thead>
            <tbody>
              {ledgerEvidence.length === 0 && <tr><td colSpan={8} className="empty-state">暂无失败旁证</td></tr>}
              {ledgerEvidence.map((evidence) => (
                <tr key={evidence.id}>
                  <td>{evidence.id}</td>
                  <td>{evidence.batchCode}</td>
                  <td>{evidence.recipientName ?? '批次'}</td>
                  <td>{evidence.channel ? CHANNEL_LABELS[evidence.channel] : '—'}</td>
                  <td>
                    <StatusPill
                      kind={evidence.category === 'unsubscribed' || evidence.category === 'no-channel' ? 'muted' : evidence.category === 'residual-cleanup' ? 'info' : 'bad'}
                      text={evidenceCategoryLabel(evidence.category)}
                    />
                  </td>
                  <td>{evidence.detail}</td>
                  <td>{evidence.attempts ?? '—'}</td>
                  <td>{formatTime(evidence.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'matrix' && (
          <RecipientMatrix recipients={state.recipients} rules={state.rules} />
        )}
      </article>

      {/* ------------------------------ 规则清单 ------------------------------ */}
      <article className="panel">
        <header className="panel-head">
          <h3>通知规则</h3>
          <span className="panel-hint">优先级数值越大越优先；数值相同则按登记顺序裁决</span>
        </header>
        <table className="data-table">
          <thead>
            <tr>
              <th>规则编号</th><th>名称</th><th>类型</th><th>触发条件</th><th>优先级</th><th>登记顺序</th>
              <th>渠道</th><th>接收人</th><th>合并窗口</th><th>重试上限</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {state.rules.map((rule) => (
              <tr key={rule.id}>
                <td>{rule.code}</td>
                <td>{rule.name}</td>
                <td><StatusPill kind={rule.messageClass === 'alert' ? 'warn' : 'info'} text={CLASS_TEXT[rule.messageClass]} /></td>
                <td>{rule.trigger}</td>
                <td>{rule.priority}</td>
                <td>{rule.order}</td>
                <td>{pluralChannels(rule.channels)}</td>
                <td>{rule.recipients.map(nameOf).join('、')}</td>
                <td>{rule.messageClass === 'alert' ? `${rule.mergeWindowSec}s` : '独立批次'}</td>
                <td>{rule.maxRetries} 次</td>
                <td><StatusPill kind={rule.status === '已启用' ? 'ok' : 'muted'} text={rule.status} /></td>
                <td>
                  <button className="link" type="button" onClick={() => center.toggle(rule.id)}>
                    {rule.status === '已启用' ? '停用' : '启用'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>

      <footer className="page-foot">
        <span>送达中心数据保存在本机浏览器里（{NOTIFY_TIP}）；刷新不会丢失批次、回执与旁证。</span>
      </footer>
    </section>
  )
}

const NOTIFY_TIP = 'interactive-analytics-lab:notify-center'

type BatchDetailProps = {
  batch: Batch
  state: ReturnType<typeof useNotifyCenter>['state']
  onClose: () => void
}

function BatchDetail({ batch, state, onClose }: BatchDetailProps) {
  const delivered = batch.deliveries.filter((delivery) => delivery.state === 'delivered').length
  return (
    <div className="batch-detail">
      <div className="detail-head">
        <div>
          <h4>
            {batch.code}
            <StatusPill kind={batch.messageClass === 'alert' ? 'warn' : 'info'} text={CLASS_TEXT[batch.messageClass]} />
            <StatusPill kind={batchPillKind(batch.status)} text={BATCH_STATUS_TEXT[batch.status]} />
          </h4>
          <p className="field-hint">
            创建 {formatTime(batch.createdAt)} · 合并 {batch.mergedCount} 次 · 窗口 {batch.mergeWindowSec}s ·
            进度 {batch.cursor}/{batch.deliveries.length} · 已送达 {delivered} 位
          </p>
          {batch.resumeNote && <p className="resume-note">{batch.resumeNote}</p>}
        </div>
        <button className="link" type="button" onClick={onClose}>收起</button>
      </div>

      <div className="resolution-box">
        <p className="preview-title">接收列表裁决</p>
        <p>{batch.resolution.explanation}</p>
        <div className="resolution-rules">
          {batch.resolution.contributions.map((contribution) => {
            const name = (id: string) => state.recipients.find((item) => item.id === id)?.name ?? id
            return (
              <span key={contribution.ruleCode} className="chip">
                {contribution.ruleCode} · 优先级 {contribution.priority} · 登记 {contribution.order} · {contribution.recipients.map(name).join('、')}
              </span>
            )
          })}
        </div>
      </div>

      <table className="data-table detail-table">
        <thead>
          <tr><th>接收人</th><th>状态</th><th>本接收人尝试</th><th>渠道尝试</th><th>回执</th><th>备注</th></tr>
        </thead>
        <tbody>
          {batch.deliveries.map((delivery, index) => (
            <tr key={delivery.recipientId} className={index === batch.cursor && delivery.state === 'pending' ? 'row-current' : ''}>
              <td>
                {delivery.recipientName}
                {index === batch.cursor && delivery.state === 'pending' && <span className="cursor-badge">当前</span>}
              </td>
              <td><StatusPill kind={deliveryPillKind(delivery.state)} text={deliveryStateLabel(delivery.state)} /></td>
              <td>已发 {delivery.attempts} 次（上限 {delivery.maxRetries} 次重试）</td>
              <td>
                <div className="channel-chips">
                  {delivery.channels.length === 0 && <span className="field-hint">无可达渠道</span>}
                  {delivery.channels.map((channel) => (
                    <span key={channel.channel} className={`mini-chip mini-${channel.state}`}>
                      {CHANNEL_LABELS[channel.channel]}·{channelStateLabel(channel.state)}（{channel.attempts}）
                    </span>
                  ))}
                </div>
              </td>
              <td>
                {delivery.deliveredChannel
                  ? state.receipts.find(
                      (receipt) =>
                        receipt.batchId === batch.id &&
                        receipt.recipientId === delivery.recipientId &&
                        receipt.channel === delivery.deliveredChannel,
                    )?.id ?? '—'
                  : '—'}
              </td>
              <td>{delivery.note ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="timeline">
        <p className="preview-title">事件时间线</p>
        {batch.events.map((event, index) => (
          <div key={`${event.at}-${index}`} className="timeline-item">
            <span className="timeline-time">{formatTime(event.at)}</span>
            <span className="timeline-trigger">{event.trigger}</span>
            <span className="timeline-note">{event.note ?? ''}</span>
          </div>
        ))}
      </div>

      {batch.cleanup && (
        <div className="cleanup-box">
          <p className="preview-title">清理记录</p>
          <p>
            {formatTime(batch.cleanup.at)} · {batch.cleanup.reason}：作废未完成接收人 {batch.cleanup.droppedDeliveries} 位；
            保留成功回执 {batch.cleanup.keptReceipts} 条、失败旁证 {batch.cleanup.keptEvidence} 条。
          </p>
        </div>
      )}
    </div>
  )
}

function RecipientMatrix({ recipients, rules }: { recipients: Recipient[]; rules: NotifyRule[] }) {
  return (
    <>
      <p className="field-hint">
        并集：所有选中规则的接收人去重后全部覆盖。交集：只保留在每条选中规则里都出现的接收人。
        渠道退订只影响该渠道，同一接收人的其他渠道照常发送。
      </p>
      <table className="data-table">
        <thead>
          <tr><th>接收人</th><th>部门</th><th>可达渠道</th><th>已退订</th><th>规则归属与渠道计划</th></tr>
        </thead>
        <tbody>
          {recipients.map((recipient) => (
            <tr key={recipient.id}>
              <td>{recipient.name}</td>
              <td>{recipient.dept}</td>
              <td>{pluralChannels(recipient.channels)}</td>
              <td>
                {recipient.unsubscribed.length === 0
                  ? '—'
                  : recipient.unsubscribed.map((channel) => (
                      <span key={channel} className="mini-chip mini-unsubscribed">{CHANNEL_LABELS[channel]}已退订</span>
                    ))}
              </td>
              <td>
                {rules.filter((rule) => rule.recipients.includes(recipient.id)).length === 0 && <span className="field-hint">不在任何规则名单</span>}
                {rules
                  .filter((rule) => rule.recipients.includes(recipient.id))
                  .map((rule) => {
                    const channels = rule.channels.filter((channel) => recipient.channels.includes(channel))
                    return (
                      <span key={rule.id} className="chip">
                        {rule.code}：{channels.length > 0 ? pluralChannels(channels) : '无可达渠道'}
                      </span>
                    )
                  })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
