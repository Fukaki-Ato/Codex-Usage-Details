const API_USAGE_URL = 'https://api.openai.com/v1/organization/usage/completions'
const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api'
const { isOpenAiModel } = require('./models.cjs')
const usageSnapshotCache = new Map()
const subscriptionPayloadCache = new Map()

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

async function fetchApiBuckets(secret, range) {
  const window = rangeWindow(range)
  const headers = {
    Authorization: `Bearer ${secret.apiKey}`,
    Accept: 'application/json',
  }
  if (secret.organizationId) headers['OpenAI-Organization'] = secret.organizationId

  const buckets = []
  let page
  for (let pageIndex = 0; pageIndex < 1000; pageIndex += 1) {
    const params = new URLSearchParams({
      start_time: String(window.start),
      end_time: String(window.end),
      bucket_width: window.bucketWidth,
      limit: window.bucketWidth === '1h' ? '168' : '31',
    })
    params.append('group_by[]', 'model')
    if (page) params.set('page', page)
    const payload = await fetchJson(`${API_USAGE_URL}?${params.toString()}`, { headers })
    if (Array.isArray(payload.data)) buckets.push(...payload.data)
    if (!payload.has_more || !payload.next_page) break
    page = payload.next_page
    if (pageIndex === 999) throw new Error('官方 API 用量历史过长，分页读取未完成。')
  }
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
      existing.requestCount += toNumber(result.num_model_requests)
      existing.cachedTokens += toNumber(result.input_cached_tokens)
      existing.uncachedTokens += result.input_uncached_tokens == null
        ? Math.max(0, toNumber(result.input_tokens) - toNumber(result.input_cached_tokens))
        : toNumber(result.input_uncached_tokens)
      existing.outputTokens += toNumber(result.output_tokens)
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
    resetsAt: toNumber(window.reset_at) * 1000 || null,
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
  const windows = [
    primaryWindow ? { label: '5 小时额度', ...primaryWindow } : null,
    secondaryWindow ? { label: '周额度', ...secondaryWindow } : null,
  ].filter(Boolean)
  if (!windows.length) {
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
  if (!forceRefresh && cachedPayload?.accessToken === credentials.secret.accessToken) {
    payload = cachedPayload.payload
  } else {
    try {
      payload = await requestUsage(credentials)
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) throw error
      credentials = await getSubscriptionCredentials(accountId, true)
      payload = await requestUsage(credentials)
    }
    subscriptionPayloadCache.set(accountId, { accessToken: credentials.secret.accessToken, payload })
  }
  const { fetchLocalCodexModelUsage, localRowsToModels } = require('./local-usage.cjs')
  let localUsage
  try {
    localUsage = await fetchLocalCodexModelUsage(range, { codexHome: credentials.account.codexHome, force: forceRefresh })
  } catch (error) {
    localUsage = { available: false, models: [], modelDaily: [], modelHourly: [], error: error instanceof Error ? error.message : '无法读取本机会话日志。' }
  }
  const models = localRowsToModels(localUsage, range, new Date())
  const localWarning = localUsage.warning ? ` ${localUsage.warning}` : ''
  return {
    accountId,
    source: 'subscription',
    range,
    mode: 'live',
    models,
    subscription: normalizeSubscriptionPayload(payload, credentials.account.remoteAccountId),
    updatedAt: Date.now(),
    notice: models.length
      ? `订阅额度来自官方 /wham/usage；模型明细来自本机 Codex 会话日志。${localWarning}`
      : `订阅额度来自官方 /wham/usage；当前本机没有可展示的 Codex 模型会话记录。${localWarning}`,
  }
}

async function getUsage({ accountId, source, range, refreshToken = 0 }) {
  if (!accountId || !['api', 'subscription'].includes(source) || !['today', '7d', '30d', 'all'].includes(range)) {
    throw new Error('用量请求参数无效。')
  }
  const cacheKey = `${source}:${accountId}`
  let accountCache = usageSnapshotCache.get(cacheKey)
  const forceRefresh = !accountCache || accountCache.refreshToken !== refreshToken
  if (forceRefresh) {
    accountCache = { refreshToken, snapshots: new Map() }
    usageSnapshotCache.set(cacheKey, accountCache)
  }
  const cachedSnapshot = accountCache.snapshots.get(range)
  if (cachedSnapshot) return cachedSnapshot
  const snapshot = source === 'api'
    ? await getApiUsage(accountId, range)
    : await getSubscriptionUsage(accountId, range, { forceRefresh })
  accountCache.snapshots.set(range, snapshot)
  return snapshot
}

module.exports = { getUsage, normalizeApiBuckets, normalizeSubscriptionPayload, rangeWindow }
