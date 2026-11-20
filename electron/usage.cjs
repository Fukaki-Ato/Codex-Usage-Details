const API_USAGE_URL = 'https://api.openai.com/v1/organization/usage/completions'
const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api'
const { isOpenAiModel } = require('./models.cjs')
const { ULTRAFAST_LIST_RATE_START, addAcceleratedUsage } = require('./speed-usage.cjs')
const usageSnapshotCache = new Map()
const subscriptionPayloadCache = new Map()
const CACHE_TTL_MS = 60_000

function invalidateAccount(accountId) {
  for (const key of usageSnapshotCache.keys()) if (key.endsWith(`:${accountId}`)) usageSnapshotCache.delete(key)
  subscriptionPayloadCache.delete(accountId)
}

function toNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function rangeWindow(range) {
  const now = new Date()
  const end = Math.floor(Date.now() / 1000)
  if (range === 'today') {
    now.setMinutes(0, 0, 0)
    now.setTime(now.getTime() - 23 * 60 * 60 * 1000)
    return { start: Math.floor(now.getTime() / 1000), end, bucketWidth: '1h', interval: 60 * 60 * 1000 }
  }
  if (range === '7d' || range === '30d') {
    const days = range === '7d' ? 7 : 30
    now.setHours(0, 0, 0, 0)
    now.setDate(now.getDate() - days + 1)
    return { start: Math.floor(now.getTime() / 1000), end, bucketWidth: '1d', interval: 24 * 60 * 60 * 1000 }
  }
  return { start: end - 3650 * 24 * 60 * 60, end, bucketWidth: '1d', interval: 24 * 60 * 60 * 1000 }
}

async function fetchJson(url, options) {
  const { requestText } = require('./http.cjs')
  const response = await requestText(url, options)
  let body = {}
  try {
    body = JSON.parse(response.body || '{}')
  } catch {
    body = {}
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const error = new Error(response.statusCode === 401 || response.statusCode === 403
      ? '账户凭据无权读取该官方用量接口。'
      : `官方用量接口返回 HTTP ${response.statusCode}。`)
    error.status = response.statusCode
    throw error
  }
  return body
}

async function fetchApiPeriod(headers, { start, end, bucketWidth }) {
  const buckets = []
  let page
  for (let pageIndex = 0; pageIndex < 1000; pageIndex += 1) {
    const params = new URLSearchParams({
      start_time: String(start),
      end_time: String(end),
      bucket_width: bucketWidth,
      limit: bucketWidth === '1h' ? '168' : '31',
    })
    params.append('group_by[]', 'model')
    params.append('group_by[]', 'service_tier')
    if (page) params.set('page', page)
    const payload = await fetchJson(`${API_USAGE_URL}?${params.toString()}`, { headers })
    if (!Array.isArray(payload.data)) throw new Error('API 用量接口响应结构不兼容，未取得有效数据。')
    for (const bucket of payload.data) {
      // A clipped bucket can retain its original label while only counting
      // usage from the requested period.
      buckets.push({ ...bucket, pricingStartTime: Math.max(toNumber(bucket.start_time), start) })
    }
    if (!payload.has_more || !payload.next_page) break
    page = payload.next_page
    if (pageIndex === 999) throw new Error('官方 API 用量历史过长，分页读取未完成。')
  }
  return buckets
}

async function fetchApiBuckets(secret, range) {
  const window = rangeWindow(range)
  const headers = {
    Authorization: `Bearer ${secret.apiKey}`,
    Accept: 'application/json',
  }
  if (secret.organizationId) headers['OpenAI-Organization'] = secret.organizationId

  const cutover = ULTRAFAST_LIST_RATE_START / 1000
  const periods = window.start < cutover && cutover < window.end
    ? [{ ...window, end: cutover }, { ...window, start: cutover }]
    : [window]
  const buckets = []
  for (const period of periods) buckets.push(...await fetchApiPeriod(headers, period))
  return { buckets, window }
}

function formatLocalDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function apiTimeline(range, window, rawTimestamps) {
  if (!range) return [...rawTimestamps.entries()].sort((left, right) => left[1] - right[1]).map(([key, timestamp]) => ({ key, timestamp }))
  const now = new Date(window.end * 1000)
  const timeline = []
  if (range === 'today') {
    const end = new Date(now)
    end.setMinutes(0, 0, 0)
    const start = new Date(end.getTime() - 23 * 60 * 60 * 1000)
    for (let timestamp = start.getTime(); timestamp <= end.getTime(); timestamp += 60 * 60 * 1000) {
      const date = new Date(timestamp)
      timeline.push({ key: `${formatLocalDate(date)}T${String(date.getHours()).padStart(2, '0')}`, timestamp })
    }
    return timeline
  }
  if (range === '7d' || range === '30d') {
    const count = range === '7d' ? 7 : 30
    const start = new Date(now)
    start.setHours(12, 0, 0, 0)
    start.setDate(start.getDate() - count + 1)
    for (let index = 0; index < count; index += 1) {
      const timestamp = start.getTime() + index * 24 * 60 * 60 * 1000
      timeline.push({ key: formatLocalDate(new Date(timestamp)), timestamp })
    }
    return timeline
  }
  const dates = [...rawTimestamps.keys()].sort()
  if (!dates.length) return []
  const start = new Date(`${dates[0]}T12:00:00`)
  const end = new Date(`${dates[dates.length - 1]}T12:00:00`)
  for (let timestamp = start.getTime(); timestamp <= end.getTime(); timestamp += 24 * 60 * 60 * 1000) {
    timeline.push({ key: formatLocalDate(new Date(timestamp)), timestamp })
  }
  return timeline
}

function normalizeApiBuckets(rawBuckets, window, range) {
  const modelMaps = new Map()
  const timestamps = new Map()
  const hourly = window.bucketWidth === '1h'
  for (const bucket of rawBuckets) {
    const timestamp = toNumber(bucket.start_time) * 1000
    if (!timestamp) continue
    const pricingTimestamp = bucket.pricingStartTime == null ? timestamp : toNumber(bucket.pricingStartTime) * 1000
    const date = new Date(timestamp)
    const key = hourly ? `${formatLocalDate(date)}T${String(date.getHours()).padStart(2, '0')}` : formatLocalDate(date)
    timestamps.set(key, timestamp)
    for (const result of Array.isArray(bucket.results) ? bucket.results : []) {
      const model = isOpenAiModel(result.model) ? result.model.trim() : ''
      if (!model) continue
      if (!modelMaps.has(model)) modelMaps.set(model, new Map())
      const map = modelMaps.get(model)
      const existing = map.get(key) || {
        timestamp,
        requestCount: 0,
        cachedTokens: 0,
        uncachedTokens: 0,
        reasoningTokens: 0,
        outputTokens: 0,
      }
      const cachedTokens = toNumber(result.input_cached_tokens)
      const recordedCacheWrite12hTokens = toNumber(result.input_cache_write_12h_tokens)
      const cacheWriteTokens = result.input_cache_write_tokens == null
        ? toNumber(result.input_cache_write_30m_tokens) + recordedCacheWrite12hTokens
        : toNumber(result.input_cache_write_tokens)
      const cacheWrite12hTokens = Math.max(0, Math.min(cacheWriteTokens, recordedCacheWrite12hTokens))
      const uncachedTokens = result.input_uncached_tokens == null
        ? Math.max(0, toNumber(result.input_tokens) - cachedTokens - cacheWriteTokens)
        : toNumber(result.input_uncached_tokens)
      const outputTokens = toNumber(result.output_tokens)
      existing.requestCount += toNumber(result.num_model_requests)
      existing.cachedTokens += cachedTokens
      existing.uncachedTokens += uncachedTokens
      if (cacheWriteTokens) existing.cacheWriteTokens = (existing.cacheWriteTokens || 0) + cacheWriteTokens
      if (cacheWrite12hTokens) existing.cacheWrite12hTokens = (existing.cacheWrite12hTokens || 0) + cacheWrite12hTokens
      existing.outputTokens += outputTokens
      addAcceleratedUsage(existing, result.service_tier, pricingTimestamp, { cachedTokens, uncachedTokens, cacheWriteTokens, cacheWrite12hTokens, outputTokens })
      map.set(key, existing)
    }
  }

  const timeline = apiTimeline(range, window, timestamps)
  const models = [...modelMaps.entries()].map(([model, map]) => ({
    model,
    buckets: timeline.map(({ key, timestamp }) => map.get(key) || { timestamp, requestCount: 0, cachedTokens: 0, uncachedTokens: 0, reasoningTokens: 0, outputTokens: 0 }),
  }))

  return { models, window: { start: window.start * 1000, end: window.end * 1000 } }
}

async function getApiUsage(accountId, range) {
  const storage = require('./storage.cjs')
  const { secret } = await storage.getSecret(accountId, 'api')
  const { buckets, window } = await fetchApiBuckets(secret, range)
  const normalized = normalizeApiBuckets(buckets, window, range)
  return {
    accountId,
    source: 'api',
    range,
    mode: 'live',
    models: normalized.models,
    updatedAt: Date.now(),
    notice: '数据来自 OpenAI 组织级官方用量接口。',
  }
}

function normalizeWindow(window) {
  if (window == null) return null
  if (typeof window !== 'object' || Array.isArray(window) || window.used_percent == null || !Number.isFinite(Number(window.used_percent))) {
    throw new Error('订阅用量接口响应结构不兼容，请等待适配更新。')
  }
  return {
    usedPercent: toNumber(window.used_percent),
    limitWindowSeconds: toNumber(window.limit_window_seconds),
    resetsAt: toNumber(window.reset_at) * 1000 || (toNumber(window.reset_after_seconds) > 0 ? Date.now() + toNumber(window.reset_after_seconds) * 1000 : null),
    resetAfterSeconds: toNumber(window.reset_after_seconds),
  }
}

function normalizeSubscriptionPayload(payload, accountId) {
  if (!payload || typeof payload !== 'object') throw new Error('订阅用量接口响应结构不兼容，请等待适配更新。')
  const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value)
  if (payload.rate_limit != null && !isRecord(payload.rate_limit)) throw new Error('订阅用量接口响应结构不兼容，请等待适配更新。')
  const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : {}
  const hasSupportedShape = Object.prototype.hasOwnProperty.call(rateLimit, 'primary_window')
    || Object.prototype.hasOwnProperty.call(rateLimit, 'secondary_window')
  if (!hasSupportedShape) throw new Error('订阅用量接口响应结构不兼容，请等待适配更新。')
  const primaryWindow = normalizeWindow(rateLimit.primary_window)
  const secondaryWindow = normalizeWindow(rateLimit.secondary_window)
  const isPro = typeof payload.plan_type === 'string' && /^pro(?:[\s_-]*(?:100|200|500))?$/i.test(payload.plan_type.trim())
  const label = (window, fallback) => window.limitWindowSeconds === 604800 ? '周额度' : window.limitWindowSeconds > 0 ? `${window.limitWindowSeconds / 3600} 小时额度` : fallback
  const windows = [
    primaryWindow ? { id: 'primary', label: label(primaryWindow, '短期额度'), ...primaryWindow } : null,
    secondaryWindow ? { id: 'secondary', label: label(secondaryWindow, '长期额度'), ...secondaryWindow } : null,
  ].filter((window) => window && !(isPro && window.limitWindowSeconds === 18000))
  if (!windows.length && !isPro) {
    throw new Error('订阅用量接口响应结构不兼容，请等待适配更新。')
  }
  return {
    planType: payload.plan_type || 'Unknown',
    accountId: payload.account_id || accountId,
    userId: payload.user_id || null,
    windows,
  }
}

async function getSubscriptionUsage(accountId, range, { forceRefresh = false } = {}) {
  const { getSubscriptionCredentials } = require('./auth.cjs')
  let credentials = await getSubscriptionCredentials(accountId)
  async function requestUsage(currentCredentials) {
    const headers = {
      Authorization: `Bearer ${currentCredentials.secret.accessToken}`,
      Accept: 'application/json',
      'Cache-Control': 'no-cache, no-store',
      'User-Agent': 'codex-cli',
    }
    if (currentCredentials.account.remoteAccountId) headers['ChatGPT-Account-Id'] = currentCredentials.account.remoteAccountId
    return fetchJson(`${CHATGPT_BASE_URL}/wham/usage`, { headers })
  }
  let payload
  const cachedPayload = subscriptionPayloadCache.get(accountId)
  if (!forceRefresh && cachedPayload?.accessToken === credentials.secret.accessToken && Date.now() - cachedPayload.updatedAt < CACHE_TTL_MS) {
    payload = cachedPayload.payload
  } else {
    try {
      payload = await requestUsage(credentials)
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) throw error
      credentials = await getSubscriptionCredentials(accountId, true)
      payload = await requestUsage(credentials)
    }
    subscriptionPayloadCache.set(accountId, { accessToken: credentials.secret.accessToken, payload, updatedAt: Date.now() })
  }
  const { fetchLocalCodexModelUsage, localRowsToModels } = require('./local-usage.cjs')
  let localUsage
  let localStatus = 'ready'
  try {
    const { listAccounts } = require('./storage.cjs')
    const path = require('node:path')
    const { realpath } = require('node:fs/promises')
    const homeKey = (home) => home ? (process.platform === 'win32' ? path.resolve(home).toLowerCase() : path.resolve(home)) : ''
    const selectedHome = credentials.account.codexHome ? await realpath(credentials.account.codexHome) : null
    const otherHomes = await Promise.all((await listAccounts()).filter((item) => item.id !== accountId && item.codexHome).map(async (item) => {
      try { return await realpath(item.codexHome) } catch { return null }
    }))
    const duplicate = selectedHome && otherHomes.some((home) => home && homeKey(home) === homeKey(selectedHome))
    if (!credentials.account.codexHome || duplicate) {
      localStatus = 'unconfigured'
      localUsage = { models: [], modelDaily: [], modelHourly: [], warning: duplicate ? '日志目录与其他账户重复，已暂停模型统计，请选择独立目录。' : '请为此账户选择独立使用的 Codex 数据目录；本机日志的账户归属由你确认。' }
    } else {
      localUsage = await fetchLocalCodexModelUsage(range, { codexHome: selectedHome })
      localStatus = !localUsage.available ? 'missing' : localUsage.warning ? 'partial' : 'ready'
    }
  } catch (error) {
    localStatus = 'error'
    localUsage = { available: false, models: [], modelDaily: [], modelHourly: [], error: error instanceof Error ? error.message : '无法读取本机会话日志。' }
  }
  const models = localRowsToModels(localUsage, range, new Date())
  const localWarning = localUsage.warning ? ` ${localUsage.warning}` : ''
  const modelNotice = localStatus === 'unconfigured' ? '请先配置此账户的日志目录。'
    : localStatus === 'missing' || localStatus === 'error' ? '本机模型明细暂不可用，请检查日志目录。'
      : '当前时间范围没有可展示的 Codex 模型会话记录。'
  return {
    accountId,
    source: 'subscription',
    range,
    mode: 'live',
    models,
    localUsage: { status: localStatus, directory: credentials.account.codexHome, warning: localUsage.error || localUsage.warning || (localStatus === 'missing' ? '所选目录下没有 sessions 文件夹。' : ''), attribution: 'user-selected' },
    subscription: normalizeSubscriptionPayload(payload, credentials.account.remoteAccountId),
    updatedAt: Date.now(),
    notice: models.length
      ? `订阅额度来自官方 /wham/usage；模型明细来自本机 Codex 会话日志。${localWarning}`
      : `订阅额度来自官方 /wham/usage；${modelNotice}${localWarning}`,
  }
}

async function getUsage({ accountId, source, range, refreshToken = 0 }) {
  if (!accountId || !['api', 'subscription'].includes(source) || !['today', '7d', '30d', 'all'].includes(range)) {
    throw new Error('用量请求参数无效。')
  }
  await require('./storage.cjs').getAccount(accountId, source)
  const cacheKey = `${source}:${accountId}`
  let accountCache = usageSnapshotCache.get(cacheKey)
  const forceRefresh = !accountCache || accountCache.refreshToken !== refreshToken
  if (forceRefresh) {
    accountCache = { refreshToken, snapshots: new Map() }
    usageSnapshotCache.set(cacheKey, accountCache)
  }
  const cached = accountCache.snapshots.get(range)
  if (cached?.promise) return cached.promise
  if (cached && Date.now() < cached.expiresAt) return { ...cached.snapshot, cache: { hit: true, expiresAt: cached.expiresAt } }
  const promise = (async () => {
    const snapshot = source === 'api' ? await getApiUsage(accountId, range) : await getSubscriptionUsage(accountId, range, { forceRefresh })
    const expiresAt = Date.now() + CACHE_TTL_MS
    accountCache.snapshots.set(range, { snapshot, expiresAt })
    return { ...snapshot, cache: { hit: false, expiresAt } }
  })()
  accountCache.snapshots.set(range, { promise })
  try { return await promise } catch (error) {
    if (accountCache.snapshots.get(range)?.promise === promise) accountCache.snapshots.delete(range)
    throw error
  }
}

module.exports = { getUsage, invalidateAccount, normalizeApiBuckets, normalizeSubscriptionPayload, rangeWindow }
