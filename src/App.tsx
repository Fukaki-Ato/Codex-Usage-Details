import { useEffect, useRef, useState } from 'react'
import { accounts as demoAccounts, createDemoSnapshot } from './data'
import { formatModelName, formatNumber, formatTokenValue } from './chart-utils'
import { estimateSnapshotCost } from './pricing'
import { RequestsChart, TokensChart } from './components/UsageCharts'
import brandIcon from './assets/electron-mark.png'
import type {
  SubscriptionQuotaWindow,
  SubscriptionUsageDetails,
  UsageAccount,
  UsageRange,
  UsageSnapshot,
  UsageSource,
} from './types'

const desktopBridge = window.desktopBridge

const rangeOptions: { value: UsageRange; label: string }[] = [
  { value: 'today', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'all', label: '全部' },
]

const sourceOptions: { value: UsageSource; label: string }[] = [
  { value: 'subscription', label: '订阅用量' },
  { value: 'api', label: 'API 用量' },
]

const emptyTotals = { requests: 0, cached: 0, uncached: 0, cacheWrite: 0, output: 0, reasoning: 0 }

function sumSnapshot(snapshot: UsageSnapshot) {
  return snapshot.models.reduce(
    (total, model) =>
      model.buckets.reduce(
        (modelTotal, bucket) => ({
          requests: modelTotal.requests + bucket.requestCount,
          cached: modelTotal.cached + bucket.cachedTokens,
          uncached: modelTotal.uncached + bucket.uncachedTokens,
          cacheWrite: modelTotal.cacheWrite + (bucket.cacheWriteTokens || 0),
          output: modelTotal.output + bucket.outputTokens,
          reasoning: modelTotal.reasoning + (bucket.reasoningTokens || 0),
        }),
        total,
      ),
    emptyTotals,
  )
}

function formatUsd(amount: number) {
  return `$${amount.toFixed(2)}`
}

function formatResetCountdown(seconds: number) {
  if (seconds <= 0) return '即将重置'
  const days = Math.floor(seconds / (24 * 60 * 60))
  const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60))
  const minutes = Math.floor((seconds % (60 * 60)) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时后重置`
  if (hours > 0) return `${hours} 小时 ${minutes} 分后重置`
  if (minutes > 0) return `${minutes} 分后重置`
  return `${seconds} 秒后重置`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求官方用量接口失败。'
}

function SourceIcon({ source }: { source: UsageSource }) {
  return <span className={`source-icon ${source}`} aria-hidden="true">{source === 'api' ? '</>' : '✦'}</span>
}

function QuotaWindow({ window: quota }: { window: SubscriptionQuotaWindow }) {
  const [currentTime, setCurrentTime] = useState(Date.now())
  useEffect(() => {
    const timer = globalThis.setInterval(() => setCurrentTime(Date.now()), 60_000)
    return () => globalThis.clearInterval(timer)
  }, [])
  const remainingSeconds = quota.resetsAt
    ? Math.max(0, Math.floor((quota.resetsAt - currentTime) / 1000))
    : Math.max(0, quota.resetAfterSeconds)
  const used = Math.max(0, Math.min(100, quota.usedPercent))
  return (
    <div className="quota-window">
      <div className="quota-window-head"><span>{quota.label}</span><strong>{Math.round(used)}<em>%</em></strong></div>
      <div className="quota-progress"><i style={{ width: `${used}%` }} /></div>
      <div className="quota-window-meta"><span>已使用 {Math.round(used)}%</span><span>剩余 {Math.max(0, 100 - Math.round(used))}%</span></div>
      <small>{quota.resetsAt || quota.resetAfterSeconds ? formatResetCountdown(remainingSeconds) : '预计重置时间未知'}</small>
    </div>
  )
}

function SubscriptionQuota({ details, account, onRefresh, isLoading }: { details: SubscriptionUsageDetails; account: UsageAccount; onRefresh: () => void; isLoading: boolean }) {
  const windows = details.windows
  return (
    <section className="subscription-panel">
      <div className="subscription-panel-head">
        <div><h2>ChatGPT 订阅额度</h2></div>
        <div className="subscription-account-meta"><span>{account.email || account.detail} · {details.planType}</span><button onClick={onRefresh} disabled={isLoading}>{isLoading ? '刷新中...' : '刷新额度'}</button></div>
      </div>
      <div className="quota-grid">
        {windows.map((window) => <QuotaWindow key={`${window.label}-${window.resetsAt}`} window={window} />)}
      </div>
    </section>
  )
}

function App() {
  const [accountList, setAccountList] = useState<UsageAccount[]>(desktopBridge ? [] : demoAccounts)
  const [source, setSource] = useState<UsageSource>('subscription')
  const [range, setRange] = useState<UsageRange>('7d')
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(desktopBridge ? null : 'chatgpt-pro')
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(desktopBridge ? null : createDemoSnapshot('chatgpt-pro', 'subscription', '7d'))
  const [isLoading, setIsLoading] = useState(Boolean(desktopBridge))
  const [loadError, setLoadError] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState(Date.now())
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [showAccountPanel, setShowAccountPanel] = useState(false)
  const [accountMode, setAccountMode] = useState<UsageSource>('subscription')
  const [accountName, setAccountName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [organizationId, setOrganizationId] = useState('')
  const [accountBusy, setAccountBusy] = useState(false)
  const [accountError, setAccountError] = useState<string | null>(null)
  const cancelRequested = useRef(false)

  const visibleAccounts = accountList.filter((account) => account.sources.includes(source))
  const selectedAccount = visibleAccounts.find((account) => account.id === selectedAccountId) ?? null

  useEffect(() => {
    if (!desktopBridge) return
    let cancelled = false
    desktopBridge.listAccounts().then((nextAccounts) => {
      if (cancelled) return
      setAccountList(nextAccounts)
      const first = nextAccounts.find((account) => account.sources.includes(source))
      setSelectedAccountId(first?.id ?? null)
    }).catch((error) => {
      if (!cancelled) setLoadError(errorMessage(error))
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (selectedAccountId && visibleAccounts.some((account) => account.id === selectedAccountId)) return
    setSelectedAccountId(visibleAccounts[0]?.id ?? null)
  }, [source, accountList, selectedAccountId])

  useEffect(() => {
    let cancelled = false
    if (!selectedAccountId) {
      setSnapshot(null)
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setLoadError(null)
    setSnapshot(null)
    const request = desktopBridge
      ? desktopBridge.getUsage({ accountId: selectedAccountId, source, range, refreshToken: refreshNonce })
      : Promise.resolve(createDemoSnapshot(selectedAccountId, source, range))
    request.then((nextSnapshot) => {
      if (cancelled) return
      setSnapshot(nextSnapshot)
      setLastRefreshed(Date.now())
    }).catch((error) => {
      if (!cancelled) setLoadError(errorMessage(error))
    }).finally(() => {
      if (!cancelled) setIsLoading(false)
    })
    return () => { cancelled = true }
  }, [selectedAccountId, source, range, refreshNonce])

  function changeSource(nextSource: UsageSource) {
    setSource(nextSource)
    setAccountMode(nextSource)
    const firstAccount = accountList.find((account) => account.sources.includes(nextSource))
    setSelectedAccountId(firstAccount?.id ?? null)
  }

  function refresh() {
    setLastRefreshed(Date.now())
    setRefreshNonce((value) => value + 1)
  }

  function openAccountPanel() {
    setAccountMode(source)
    setAccountError(null)
    setShowAccountPanel(true)
  }

  function closeAccountPanel() {
    if (!accountBusy) setShowAccountPanel(false)
  }

  async function reloadAccounts(preferredId?: string) {
    if (!desktopBridge) return
    const nextAccounts = await desktopBridge.listAccounts()
    setAccountList(nextAccounts)
    if (preferredId) setSelectedAccountId(preferredId)
  }

  async function addApiAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!desktopBridge) {
      setAccountError('浏览器预览模式无法保存账户，请使用 Electron 桌面应用。')
      return
    }
    setAccountBusy(true)
    setAccountError(null)
    try {
      const account = await desktopBridge.addApiAccount({ name: accountName, apiKey, organizationId })
      await reloadAccounts(account.id)
      setSource('api')
      setSelectedAccountId(account.id)
      setApiKey('')
      setAccountName('')
      setOrganizationId('')
      setShowAccountPanel(false)
    } catch (error) {
      setAccountError(errorMessage(error))
    } finally {
      setAccountBusy(false)
    }
  }

  async function startSubscriptionLogin() {
    if (!desktopBridge) {
      setAccountError('浏览器预览模式无法启动本地 OAuth 回调，请使用 Electron 桌面应用。')
      return
    }
    cancelRequested.current = false
    setAccountBusy(true)
    setAccountError(null)
    try {
      const account = await desktopBridge.startSubscriptionLogin()
      await reloadAccounts(account.id)
      setSource('subscription')
      setSelectedAccountId(account.id)
      setShowAccountPanel(false)
    } catch (error) {
      if (!cancelRequested.current) setAccountError(errorMessage(error))
    } finally {
      setAccountBusy(false)
    }
  }

  async function cancelSubscriptionLogin() {
    if (!desktopBridge) return
    cancelRequested.current = true
    await desktopBridge.cancelSubscriptionLogin()
    setAccountBusy(false)
  }

  async function removeAccount(account: UsageAccount) {
    if (!desktopBridge || !window.confirm(`确定删除账户“${account.name}”吗？`)) return
    setAccountBusy(true)
    setAccountError(null)
    try {
      await desktopBridge.removeAccount(account.id)
      await reloadAccounts()
    } catch (error) {
      setAccountError(errorMessage(error))
    } finally {
      setAccountBusy(false)
    }
  }

  async function chooseCodexHome(account: UsageAccount) {
    if (!desktopBridge) return
    setAccountBusy(true)
    setAccountError(null)
    try {
      const updated = await desktopBridge.chooseCodexHome(account.id)
      if (updated) {
        await reloadAccounts()
        setRefreshNonce((value) => value + 1)
      }
    } catch (error) {
      setAccountError(errorMessage(error))
    } finally {
      setAccountBusy(false)
    }
  }

  const totals = snapshot ? sumSnapshot(snapshot) : emptyTotals
  const totalTokens = totals.cached + totals.uncached + totals.output + totals.reasoning + totals.cacheWrite
  const cacheHitRate = totals.cached + totals.uncached > 0 ? Math.round((totals.cached / (totals.cached + totals.uncached)) * 100) : 0
  const costEstimate = snapshot ? estimateSnapshotCost(snapshot.models) : null
  const subscription = snapshot?.subscription
  const isLive = snapshot?.mode === 'live'
  const updatedLabel = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(lastRefreshed)

  return (
    <div className="dashboard-shell">
      <header className="dashboard-header">
        <div className="brand"><img className="brand-icon" src={brandIcon} alt="" aria-hidden="true" /><div><strong>Codex</strong><small>Usage Details</small></div></div>
        <div className="header-controls">
          <div className="source-switch" role="tablist" aria-label="用量来源">{sourceOptions.map((option) => <button className={source === option.value ? 'selected' : ''} key={option.value} onClick={() => changeSource(option.value)} role="tab" aria-selected={source === option.value}><SourceIcon source={option.value} />{option.label}</button>)}</div>
          <select className="account-select" aria-label="选择账户" value={selectedAccountId ?? ''} onChange={(event) => setSelectedAccountId(event.target.value || null)}><option value="">未连接账户</option>{visibleAccounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select>
          <button className="manage-button" onClick={openAccountPanel}>管理账户</button>
          <button className="refresh-button" onClick={refresh} disabled={!selectedAccount || isLoading} title="刷新数据" aria-label="刷新数据">↻</button>
        </div>
      </header>

      <main className="dashboard-main">
        <section className="dashboard-heading"><div><h1>{source === 'api' ? 'API 用量总览' : '订阅用量总览'}</h1><p>{source === 'api' ? '按模型查看请求、Token 构成和基于官方价格的费用估算。' : '查看官方账户的当前订阅额度和重置窗口。'}</p></div><div className="heading-status"><span className={`data-status ${isLive ? 'live' : 'demo'}`}><i />{isLive ? '实时数据' : desktopBridge ? '等待账户' : '演示数据'}</span>{selectedAccount && <span>更新于 {updatedLabel}</span>}</div></section>

        {source === 'api' || snapshot?.models.length ? <section className="metric-grid">
          <div className="metric-card green"><span>缓存命中率</span><strong>{selectedAccount ? `${cacheHitRate.toFixed(1)}%` : '--'}</strong></div>
          <div className="metric-card blue"><span>总 Token</span><strong>{selectedAccount ? formatNumber(totalTokens) : '--'}</strong></div>
          <div className="metric-card purple"><span>请求数</span><strong>{selectedAccount ? formatNumber(totals.requests) : '--'}</strong></div>
          <div className="metric-card coral"><span>估算费用</span><strong>{selectedAccount && costEstimate && costEstimate.unknownModels.length < (snapshot?.models.length || 0) ? `$${costEstimate.amount.toFixed(2)}` : '--'}</strong></div>
        </section> : <section className="metric-grid subscription-metrics">
          <div className="metric-card green"><span>当前套餐</span><strong>{subscription?.planType || '--'}</strong></div>
          <div className="metric-card blue"><span>5 小时额度</span><strong>{subscription?.windows[0] ? `${Math.round(subscription.windows[0].usedPercent)}%` : '--'}</strong></div>
          <div className="metric-card purple"><span>周额度</span><strong>{subscription?.windows[1] ? `${Math.round(subscription.windows[1].usedPercent)}%` : '--'}</strong></div>
          <div className="metric-card coral"><span>账户状态</span><strong>已连接</strong></div>
        </section>}

        {loadError && <section className="error-banner"><span>!</span><strong>{loadError}</strong><button onClick={refresh}>重试</button></section>}

        {source === 'subscription' && subscription && selectedAccount && <SubscriptionQuota details={subscription} account={selectedAccount} onRefresh={refresh} isLoading={isLoading} />}

        <section className="model-section">
          <div className="section-heading"><div><h2>{source === 'subscription' && subscription ? '按模型用量' : '模型用量'}</h2><p>{source === 'subscription' && subscription ? '本机 Codex 会话日志中的模型明细' : '请求趋势、Token 构成与费用估算'}</p></div><div className="range-picker" role="group" aria-label="时间范围">{rangeOptions.map((option) => <button className={range === option.value ? 'selected' : ''} key={option.value} onClick={() => setRange(option.value)}>{option.label}</button>)}</div></div>
          {isLoading ? <div className="empty-state loading-state"><span className="loading-ring" /><strong>正在读取官方用量</strong><p>请求在本地 Electron 主进程中执行。</p></div> : snapshot?.models.length ? <div className="models-list">{snapshot.models.map((model) => { const requestTotal = model.buckets.reduce((sum, bucket) => sum + bucket.requestCount, 0); const tokenTotal = model.buckets.reduce((sum, bucket) => sum + bucket.cachedTokens + bucket.uncachedTokens + (bucket.cacheWriteTokens || 0) + bucket.outputTokens + (bucket.reasoningTokens || 0), 0); return <article className="model-card" key={model.model}><div className="model-card-head"><div className="model-title"><h3>{formatModelName(model.model)}</h3></div></div><div className="charts-grid"><div className="chart-module"><div className="chart-module-head"><span>API请求次数 <b>{formatNumber(requestTotal)}</b></span></div><RequestsChart buckets={model.buckets} range={range} /></div><div className="chart-module"><div className="chart-module-head"><span>Tokens <b>{formatNumber(tokenTotal)}</b></span></div><TokensChart buckets={model.buckets} range={range} /></div></div></article> })}</div> : source === 'subscription' && subscription ? <div className="empty-state subscription-empty"><strong>当前时间范围没有本机 Codex 模型记录</strong><p>订阅额度来自官方接口，模型级请求和 Token 明细来自本机 Codex 会话日志。</p></div> : selectedAccount ? <div className="empty-state"><strong>所选时间段没有可展示的模型数据</strong><p>{loadError || '官方接口没有返回历史记录，或该账户尚未产生用量。'}</p></div> : <div className="empty-state"><strong>先连接一个账户</strong><p>连接后，应用会从官方接口读取用量，不会经过第三方服务。</p><button onClick={openAccountPanel}>管理账户 <span>→</span></button></div>}
        </section>
      </main>

      {showAccountPanel && <div className="modal-backdrop" onClick={closeAccountPanel}><section className="account-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="account-modal-title"><div className="modal-head"><div><p className="eyebrow">ACCOUNT CONNECTION</p><h2 id="account-modal-title">管理账户</h2></div><button onClick={closeAccountPanel} disabled={accountBusy} aria-label="关闭">×</button></div><div className="account-mode-switch"><button className={accountMode === 'api' ? 'selected' : ''} onClick={() => setAccountMode('api')}>API 账户</button><button className={accountMode === 'subscription' ? 'selected' : ''} onClick={() => setAccountMode('subscription')}>订阅账户</button></div>{desktopBridge && accountList.length > 0 && <div className="stored-accounts"><span className="stored-accounts-label">已保存账户</span>{accountList.map((account) => <div className="stored-account" key={account.id}><span className={`stored-account-kind ${account.sources[0]}`}>{account.sources[0] === 'api' ? 'API' : '订阅'}</span><span className="stored-account-copy"><strong>{account.name}</strong><small>{account.detail}</small></span>{account.sources.includes('subscription') && <button onClick={() => chooseCodexHome(account)} disabled={accountBusy}>日志目录</button>}<button onClick={() => removeAccount(account)} disabled={accountBusy}>删除</button></div>)}</div>}{accountMode === 'api' ? <form className="account-form" onSubmit={addApiAccount}><label>账户名称<input value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="例如：Production API" /></label><label>组织管理员 API Key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-..." autoComplete="off" required /></label><label>组织 ID <span className="optional-label">可选</span><input value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} placeholder="org-..." /></label><button className="primary-action" type="submit" disabled={accountBusy || !desktopBridge}>{accountBusy ? '保存中...' : '保存 API 账户'}</button></form> : <div className="oauth-connect"><div className="oauth-symbol"><SourceIcon source="subscription" /></div><strong>使用官方 Codex CLI 登录</strong><p>应用会打开系统浏览器，完成 OpenAI OAuth 授权后通过本机一次性回调返回。不会读取浏览器 Cookie。</p><button className="primary-action" onClick={startSubscriptionLogin} disabled={accountBusy || !desktopBridge}>{accountBusy ? '等待浏览器授权...' : '打开官方登录'}</button>{accountBusy && <button className="cancel-action" onClick={cancelSubscriptionLogin}>取消登录</button>}</div>}{accountError && <div className="account-error">{accountError}</div>}{!desktopBridge && <div className="modal-note"><span>i</span> 当前是浏览器预览模式。账户连接和安全存储只在 Electron 桌面应用中启用。</div>}<div className="modal-note"><span>i</span> 凭据使用操作系统安全存储加密，主进程请求结束后不会传回前端页面。</div></section></div>}
    </div>
  )
}

export default App
