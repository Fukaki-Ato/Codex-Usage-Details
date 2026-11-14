import { useEffect, useRef, useState } from 'react'
import { accounts as demoAccounts, createDemoSnapshot } from './data'
import { formatNumber, formatTokenValue } from './chart-utils'
import { sumBuckets } from './usage-utils'
import { AccountDialog } from './components/AccountDialog'
import { ModelUsagePanel } from './components/ModelUsagePanel'
import { estimateSnapshotCost } from './pricing'
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
    const timer = globalThis.setInterval(() => setCurrentTime(Date.now()), 1_000)
    return () => globalThis.clearInterval(timer)
  }, [])
  const remainingSeconds = quota.resetsAt
    ? Math.max(0, Math.floor((quota.resetsAt - currentTime) / 1000))
    : Math.max(0, quota.resetAfterSeconds)
  const used = Math.max(0, Math.min(100, quota.usedPercent))
  return (
    <div className={`quota-window ${used >= 95 ? 'danger' : used >= 80 ? 'warning' : ''}`}>
      <div className="quota-window-head"><span>{quota.label}</span><strong>{Math.round(used)}<em>%</em></strong></div>
      <div className="quota-progress" role="progressbar" aria-label={quota.label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${used}%` }} /></div>
      <div className="quota-window-meta"><span>已使用 {Math.round(used)}%</span><span>剩余 {Math.max(0, 100 - Math.round(used))}%</span></div>
      <small>{quota.resetsAt || quota.resetAfterSeconds ? formatResetCountdown(remainingSeconds) : '预计重置时间未知'}</small>{quota.resetsAt && <small>{new Date(quota.resetsAt).toLocaleString('zh-CN')} 重置</small>}
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
        {windows.map((window) => <QuotaWindow key={window.id} window={window} />)}
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
    const request = desktopBridge
      ? desktopBridge.getUsage({ accountId: selectedAccountId, source, range, refreshToken: refreshNonce })
      : Promise.resolve(createDemoSnapshot(selectedAccountId, source, range))
    request.then((nextSnapshot) => {
      if (cancelled) return
      setSnapshot(nextSnapshot)
    }).catch((error) => {
      if (!cancelled) setLoadError(errorMessage(error))
    }).finally(() => {
      if (!cancelled) setIsLoading(false)
    })
    return () => { cancelled = true }
  }, [selectedAccountId, source, range, refreshNonce])

  useEffect(() => {
    if (!desktopBridge || !selectedAccountId) return
    const timer = globalThis.setInterval(() => setRefreshNonce((value) => value + 1), 60_000)
    return () => globalThis.clearInterval(timer)
  }, [selectedAccountId, source])

  function changeSource(nextSource: UsageSource) {
    setSource(nextSource)
    setAccountMode(nextSource)
    const firstAccount = accountList.find((account) => account.sources.includes(nextSource))
    setSelectedAccountId(firstAccount?.id ?? null)
  }

  function refresh() {
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
    const cancelled = await desktopBridge.cancelSubscriptionLogin()
    if (cancelled) setAccountBusy(false)
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

  const current = snapshot?.accountId === selectedAccountId && snapshot.source === source && snapshot.range === range ? snapshot : null
  const totals = sumBuckets(current?.models.flatMap((model) => model.buckets) || [])
  const cost = current ? estimateSnapshotCost(current.models) : null
  const subscription = current?.subscription
  const status = loadError ? (/授权|凭据|登录/.test(loadError) ? '授权失效' : '读取失败') : !selectedAccount ? '未连接' : isLoading ? '加载中' : current?.mode === 'demo' ? '演示数据' : '已连接'
  const updatedLabel = current ? new Date(current.updatedAt).toLocaleString('zh-CN') : null
  const hasCost = !!cost?.byModel.some((item) => item.estimate !== null)
  const rangeLabel = rangeOptions.find((option) => option.value === range)?.label
  return <div className="dashboard-shell">
    <header className="dashboard-header">
      <div className="brand"><img className="brand-icon" src={brandIcon} alt="" /><div><strong>Codex</strong><small>Usage Details</small></div></div>
      <div className="header-controls">
        <div className="source-switch" role="group" aria-label="用量来源">{sourceOptions.map((option) => <button aria-pressed={source === option.value} className={source === option.value ? 'selected' : ''} key={option.value} onClick={() => changeSource(option.value)}><SourceIcon source={option.value} />{option.label}</button>)}</div>
        <select className="account-select" aria-label="选择账户" value={selectedAccountId ?? ''} onChange={(event) => setSelectedAccountId(event.target.value || null)}><option value="" disabled={visibleAccounts.length > 0}>未连接账户</option>{visibleAccounts.map((account) => <option value={account.id} key={account.id}>{account.name} · {account.email || account.detail}</option>)}</select>
        <button className="manage-button" onClick={openAccountPanel}>管理账户</button>
        <button className="refresh-button" onClick={refresh} disabled={!selectedAccount || isLoading} title="刷新数据" aria-label="刷新数据">↻</button>
      </div>
    </header>
    <main className="dashboard-main">
      <section className="dashboard-heading"><div><h1>{source === 'api' ? 'API 用量总览' : '订阅用量总览'}</h1><p>{source === 'api' ? '组织级模型用量与标准文本价格估算' : '当前订阅额度 · 独立目录中的本机模型记录'}</p></div>
        <div className="heading-status" aria-live="polite"><span className={`data-status ${loadError ? 'error' : current?.mode === 'live' ? 'live' : 'demo'}`}><i />{status}</span><span>{updatedLabel ? `更新于 ${updatedLabel}${current?.cache?.hit ? ' · 缓存' : ''}` : '尚未取得数据'}{desktopBridge && selectedAccount ? ' · 每分钟自动刷新' : ''}</span></div>
      </section>
      {loadError && <section className="error-banner" role="alert"><strong>{loadError}{current ? ' 当前保留上次成功数据。' : ''}</strong><button disabled={isLoading} onClick={refresh}>重试</button><button onClick={openAccountPanel}>管理账户</button></section>}
      {source === 'subscription' && subscription && selectedAccount && <SubscriptionQuota details={subscription} account={selectedAccount} onRefresh={refresh} isLoading={isLoading} />}
      {source === 'subscription' && !subscription && <section className="connection-card"><span>账户状态</span><strong>{status}</strong><p>{selectedAccount ? '取得订阅额度后会显示窗口和重置时间。' : '连接账户后查看当前订阅额度。'}</p></section>}
      <div className="summary-caption"><span>{rangeLabel} · {source === 'subscription' ? '本机日志统计' : '组织 API 统计'}</span>{isLoading && <span role="status">正在更新…</span>}</div>
      <section className="metric-grid" aria-label="用量摘要">
        <div className="metric-card green"><span>输入缓存命中率</span><strong>{current ? `${(totals.input ? totals.cached / totals.input * 100 : 0).toFixed(1)}%` : '--'}</strong></div>
        <div className="metric-card blue"><span>总 Token</span><strong title={current ? formatNumber(totals.tokens) : undefined}>{current ? formatTokenValue(totals.tokens) : '--'}</strong><small>推理包含在输出中</small></div>
        <div className="metric-card purple"><span>{source === 'api' ? 'API 请求数' : '用量记录数'}</span><strong>{current ? formatNumber(totals.requests) : '--'}</strong></div>
        <div className="metric-card coral"><span>{cost?.unknownModels.length ? '已计价模型小计' : source === 'api' ? '估算费用' : '按 API 价格折算'}</span><strong>{hasCost ? `$${cost!.amount.toFixed(2)}` : '--'}</strong><small>{source === 'subscription' ? '等值估算，不代表订阅账单' : 'Standard 文本价格 · USD'}</small></div>
      </section>
      {current?.notice && <p className="data-note">{current.notice}</p>}
      {cost && cost.unknownModels.length > 0 && <div className="warning-banner" role="status">以下模型未计入金额：{cost.unknownModels.join('、')}。总 Token 和记录数仍包含这些模型。</div>}
      {source === 'subscription' && selectedAccount && <div className="log-source"><div><strong>模型明细来源</strong><p>{!desktopBridge ? '演示数据（不读取本机日志）' : selectedAccount.codexHome || '尚未选择日志目录'}</p><small>目录归属由你确认，应用无法从日志自动验证账户身份。</small></div><button onClick={openAccountPanel}>设置日志目录</button></div>}
      {current?.localUsage?.warning && <div className="warning-banner" role={current.localUsage.status === 'error' ? 'alert' : 'status'}>{current.localUsage.warning}</div>}
      <section className="model-section" aria-busy={isLoading}>
        <div className="section-heading"><div><h2>模型用量</h2><p>{source === 'subscription' ? '记录数来自日志中的用量事件，不等同于官方计费请求数' : '比较模型用量，选择模型查看趋势'}</p></div><div className="range-picker" role="group" aria-label="时间范围">{rangeOptions.map((option) => <button aria-pressed={range === option.value} className={range === option.value ? 'selected' : ''} key={option.value} onClick={() => setRange(option.value)}>{option.label}</button>)}</div></div>
        {current?.models.length ? <ModelUsagePanel models={current.models} range={range} source={source} /> : <div className="empty-state">
          <strong>{isLoading ? '正在读取用量…' : loadError ? '用量读取失败' : !selectedAccount ? '先连接一个账户' : current?.localUsage?.status === 'unconfigured' ? '先配置此账户的日志目录' : current?.localUsage?.status === 'error' ? '本机日志读取失败' : '当前时间范围没有模型记录'}</strong>
          {!selectedAccount && <button onClick={openAccountPanel}>管理账户 →</button>}
        </div>}
      </section>
    </main>
    {showAccountPanel && <AccountDialog busy={accountBusy} onClose={closeAccountPanel}>
      <div className="account-mode-switch"><button disabled={accountBusy} className={accountMode === 'api' ? 'selected' : ''} onClick={() => setAccountMode('api')}>API 账户</button><button disabled={accountBusy} className={accountMode === 'subscription' ? 'selected' : ''} onClick={() => setAccountMode('subscription')}>订阅账户</button></div>
      {desktopBridge && accountList.length > 0 && <div className="stored-accounts"><span className="stored-accounts-label">已保存账户</span>{accountList.map((account) => <div className="stored-account" key={account.id}>
        <span className={`stored-account-kind ${account.sources[0]}`}>{account.sources[0] === 'api' ? 'API' : '订阅'}</span><span className="stored-account-copy"><strong>{account.name}</strong><small>{account.detail}</small>{account.sources.includes('subscription') && <small title={account.codexHome}>{account.codexHome || '尚未选择独立日志目录'}</small>}</span>
        {account.sources.includes('subscription') && <><button disabled={accountBusy} onClick={() => chooseCodexHome(account)}>日志目录</button><button disabled={accountBusy} onClick={startSubscriptionLogin}>重新登录</button></>}
        <button disabled={accountBusy} onClick={() => removeAccount(account)}>删除</button>
      </div>)}</div>}
      {accountMode === 'api' ? <form className="account-form" onSubmit={addApiAccount}>
        <label>账户名称<input disabled={accountBusy} value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="例如：Production API" /></label>
        <label>组织管理员 API Key<input disabled={accountBusy} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-..." autoComplete="off" required /></label>
        <label>组织 ID（可选）<input disabled={accountBusy} value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} placeholder="org-..." /></label>
        <button className="primary-action" type="submit" disabled={accountBusy || !desktopBridge}>{accountBusy ? '保存中…' : '保存 API 账户'}</button>
      </form> : <div className="oauth-connect"><strong>使用官方 OAuth 登录</strong><p>在系统浏览器完成授权。连接成功后，请为此账户选择独立日志目录。</p><button className="primary-action" onClick={startSubscriptionLogin} disabled={accountBusy || !desktopBridge}>{accountBusy ? '正在连接…' : '打开官方登录'}</button>{accountBusy && <button className="cancel-action" onClick={cancelSubscriptionLogin}>取消登录</button>}</div>}
      {accountError && <div className="account-error" role="alert">{accountError}</div>}
      {!desktopBridge && <p className="modal-note">当前是演示模式；账户连接仅在桌面应用中启用。</p>}
      <p className="modal-note">凭据由操作系统安全存储加密。订阅额度来自官方接口，本机日志的账户归属需要手动确认。</p>
    </AccountDialog>}
  </div>
}
export default App
