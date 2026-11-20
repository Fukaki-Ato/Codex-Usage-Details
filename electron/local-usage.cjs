const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Worker, isMainThread, parentPort } = require('node:worker_threads')
const { isOpenAiModel } = require('./models.cjs')
const { readSessionFile } = require('./session-reader.cjs')
const { addAcceleratedUsage, mergeAcceleratedUsage } = require('./speed-usage.cjs')

const MAX_SESSION_FILES = 10_000
const MAX_SESSION_DEPTH = 32

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

const sessionCache = new Map()
const fileCache = new Map()

function rangeStart(range, now = new Date()) {
  if (range === 'today') {
    const end = new Date(now)
    end.setMinutes(0, 0, 0)
    return new Date(end.getTime() - 23 * 60 * 60 * 1000)
  }
  if (range === 'all') return null
  const days = { today: 1, '7d': 7, '30d': 30 }[range] || 7
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - days + 1)
  return start
}

function asInt(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

function emptyUsage() {
  return {
    requestCount: 0,
    totalInputTokens: 0,
    uncachedInputTokens: 0,
    cacheHitTokens: 0,
    cacheWriteTokens: 0,
    totalOutputTokens: 0,
    reasoningTokens: 0,
  }
}

function usageCounts(usage) {
  const inputTokens = asInt(usage?.input_tokens)
  const cacheHitTokens = Math.min(inputTokens, asInt(usage?.cached_input_tokens))
  const cacheWriteTokens = asInt(usage?.cache_write_input_tokens ?? usage?.cache_write_tokens)
  const outputTokens = asInt(usage?.output_tokens)
  const reasoningTokens = asInt(usage?.reasoning_output_tokens)
  if (!inputTokens && !cacheWriteTokens && !outputTokens && !reasoningTokens) return null
  return {
    cachedTokens: cacheHitTokens,
    uncachedTokens: inputTokens - cacheHitTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
  }
}

function addUsage(target, counts, serviceTier, timestampMs) {
  target.requestCount += 1
  target.totalInputTokens += counts.cachedTokens + counts.uncachedTokens + counts.cacheWriteTokens
  target.uncachedInputTokens += counts.uncachedTokens
  target.cacheHitTokens += counts.cachedTokens
  target.cacheWriteTokens += counts.cacheWriteTokens
  target.totalOutputTokens += counts.outputTokens
  target.reasoningTokens += counts.reasoningTokens
  addAcceleratedUsage(target, serviceTier, timestampMs, counts)
}

function modelRow(model, values, date, hour) {
  const inputTokens = values.cacheHitTokens + values.uncachedInputTokens + values.cacheWriteTokens
  const outputTokens = values.totalOutputTokens
  const row = {
    model,
    requestCount: values.requestCount,
    cachedTokens: values.cacheHitTokens,
    uncachedTokens: values.uncachedInputTokens,
    cacheWriteTokens: values.cacheWriteTokens,
    outputTokens,
    totalInputTokens: inputTokens,
    reasoningTokens: values.reasoningTokens,
  }
  if (date) row.date = date
  if (hour) row.hour = hour
  if (values.acceleratedUsage) row.acceleratedUsage = values.acceleratedUsage
  return row
}

function createSessionParser({ range = '7d', now = new Date() } = {}) {
  const start = rangeStart(range, now)
  const models = new Map()
  const daily = new Map()
  const hourly = new Map()
  let sessionId
  let threadSettings
  let activeTurn
  let currentModel = ''
  let previousTotal = ''
  let malformed = 0

  function consume(line) {
    if (!line.trim()) return
    let event
    try {
      event = JSON.parse(line)
    } catch {
      malformed += 1
      return
    }
    const payload = event?.payload || {}
    if (event?.type === 'session_meta') {
      sessionId ||= payload.id
      return
    }
    if (event?.type === 'event_msg') {
      if (payload.type === 'thread_settings_applied') {
        if (sessionId && payload.thread_id && payload.thread_id !== sessionId) return
        if (payload.thread_settings && typeof payload.thread_settings === 'object' && !Array.isArray(payload.thread_settings)) {
          // Codex can write the initial checkpoint after the first turn context.
          if (!threadSettings && activeTurn && !activeTurn.hasUsage) activeTurn.settings = payload.thread_settings
          threadSettings = payload.thread_settings
        }
        return
      }
      if (payload.type === 'task_started' || payload.type === 'turn_started') {
        if (!payload.turn_id || activeTurn?.id !== payload.turn_id) activeTurn = { id: payload.turn_id, settings: threadSettings }
        return
      }
      if (payload.type === 'task_complete' || payload.type === 'turn_complete' || payload.type === 'turn_aborted') {
        if (!payload.turn_id || !activeTurn?.id || activeTurn.id === payload.turn_id) activeTurn = undefined
        return
      }
    }
    if (event?.type === 'world_state' || event?.type === 'turn_context') {
      const mode = payload?.state?.collaboration_mode || payload.collaboration_mode
      const model = event.type === 'turn_context' ? payload.model || mode?.model || mode?.settings?.model : mode?.model || mode?.settings?.model
      if (model === undefined) return
      currentModel = isOpenAiModel(model) ? model.trim() : ''
      if (event.type === 'turn_context' && (!activeTurn?.id || (payload.turn_id && payload.turn_id !== activeTurn.id))) {
        // A settings update during a known turn applies to subsequent turns.
        activeTurn = { id: payload.turn_id, settings: threadSettings }
      }
      return
    }
    if (event?.type !== 'event_msg' || payload.type !== 'token_count') return
    const total = payload?.info?.total_token_usage
    // Rate-limit-only notifications can repeat the previous response usage.
    if (total) {
      const signature = JSON.stringify([total.input_tokens, total.cached_input_tokens, total.cache_write_input_tokens, total.output_tokens, total.reasoning_output_tokens, total.total_tokens])
      if (signature === previousTotal) return
      previousTotal = signature
    }
    if (!currentModel) return
    const counts = usageCounts(payload?.info?.last_token_usage)
    if (!counts) return
    if (activeTurn) activeTurn.hasUsage = true
    const timestamp = new Date(event.timestamp)
    const timestampMs = timestamp.getTime()
    if (Number.isNaN(timestampMs) || timestamp > now || (start && timestamp < start)) return
    const settings = activeTurn ? activeTurn.settings : threadSettings
    const settingsModel = typeof settings?.model === 'string' ? settings.model.trim().toLowerCase() : ''
    const serviceTier = !settingsModel || settingsModel === currentModel.toLowerCase() ? settings?.service_tier : undefined
    const date = `${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, '0')}-${String(timestamp.getDate()).padStart(2, '0')}`
    const hour = `${String(timestamp.getHours()).padStart(2, '0')}:00`
    addUsage(models.get(currentModel) || models.set(currentModel, emptyUsage()).get(currentModel), counts, serviceTier, timestampMs)
    const dailyKey = `${date}\u0000${currentModel}`
    const hourlyKey = `${date}\u0000${hour}\u0000${currentModel}`
    addUsage(daily.get(dailyKey) || daily.set(dailyKey, emptyUsage()).get(dailyKey), counts, serviceTier, timestampMs)
    addUsage(hourly.get(hourlyKey) || hourly.set(hourlyKey, emptyUsage()).get(hourlyKey), counts, serviceTier, timestampMs)
  }

  function finish() {
  const modelRows = [...models.entries()]
    .map(([model, values]) => modelRow(model, values))
    .sort((left, right) => right.totalInputTokens + right.outputTokens - left.totalInputTokens - left.outputTokens)
  const dailyRows = [...daily.entries()]
    .map(([key, values]) => {
      const [date, model] = key.split('\u0000')
      return modelRow(model, values, date)
    })
    .sort((left, right) => `${left.date}\u0000${left.model}`.localeCompare(`${right.date}\u0000${right.model}`))
  const hourlyRows = [...hourly.entries()]
    .map(([key, values]) => {
      const [date, hour, model] = key.split('\u0000')
      return modelRow(model, values, date, hour)
    })
    .sort((left, right) => `${left.date}\u0000${left.hour}\u0000${left.model}`.localeCompare(`${right.date}\u0000${right.hour}\u0000${right.model}`))

  return { available: true, models: modelRows, modelDaily: dailyRows, modelHourly: hourlyRows, malformed }
  }
  return { consume, finish }
}

function parseSessionText(text, options) {
  const parser = createSessionParser(options)
  for (const line of String(text).split(/\r?\n/)) parser.consume(line)
  return parser.finish()
}

async function listJsonlFiles(directory) {
  const files = []
  let truncated = false

  async function visit(currentDirectory, depth) {
    if (depth > MAX_SESSION_DEPTH || files.length >= MAX_SESSION_FILES) {
      truncated = true
      return
    }
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= MAX_SESSION_FILES) {
        truncated = true
        return
      }
      const entryPath = path.join(currentDirectory, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      files.push(entryPath)
    }
  }

  await visit(directory, 0)
  return { files, truncated }
}

function selectLocalUsage(allUsage, range, now) {
  const start = rangeStart(range, now)
  const inRange = (row) => {
    if (!start) return true
    const timestamp = range === 'today'
      ? new Date(`${row.date}T${row.hour}:00`).getTime()
      : new Date(`${row.date}T12:00:00`).getTime()
    return Number.isFinite(timestamp) && timestamp >= start.getTime()
  }
  const modelRows = (range === 'today' ? allUsage.modelHourly : allUsage.modelDaily).filter(inRange)
  const models = combineUsageRows({ available: allUsage.available, models: modelRows, modelDaily: [], modelHourly: [] }).models
  return {
    available: allUsage.available,
    models,
    modelDaily: allUsage.modelDaily.filter(inRange),
    modelHourly: allUsage.modelHourly.filter(inRange),
    warning: allUsage.warning || '',
  }
}

async function sessionSignature(files) {
  const signatures = await Promise.all(files.map(async (file) => {
    try {
      const stat = await fs.stat(file)
      return `${file}:${stat.size}:${stat.mtimeMs}`
    } catch {
      return `${file}:missing`
    }
  }))
  return signatures.join('|')
}

async function scanLocalUsage(range, { directory, codexHome, force = false, now = new Date() } = {}) {
  const sessionsDirectory = directory || path.join(codexHome || defaultCodexHome(), 'sessions')
  let scan
  try {
    scan = await listJsonlFiles(sessionsDirectory)
  } catch (error) {
    if (error.code === 'ENOENT') return { available: false, models: [], modelDaily: [], modelHourly: [] }
    throw error
  }
  const { files } = scan
  const signature = `${scan.truncated}:${await sessionSignature(files)}`
  const cached = sessionCache.get(sessionsDirectory)
  if (!force && cached?.signature === signature) return selectLocalUsage(cached.data, range, now)

  const combined = { available: true, models: [], modelDaily: [], modelHourly: [] }
  let unreadable = 0
  let malformed = 0
  for (const file of files) {
    try {
      const stat = await fs.stat(file)
      const signature = `${stat.size}:${stat.mtimeMs}`
      let parsed = fileCache.get(file)?.signature === signature && !force ? fileCache.get(file).data : null
      if (!parsed) {
        const parser = createSessionParser({ range: 'all', now })
        await readSessionFile(file, parser.consume, stat.size)
        parsed = parser.finish()
        const after = await fs.stat(file)
        if (after.size === stat.size && after.mtimeMs === stat.mtimeMs) fileCache.set(file, { signature, data: parsed })
      }
      malformed += parsed.malformed || 0
      combined.models.push(...parsed.models)
      combined.modelDaily.push(...parsed.modelDaily)
      combined.modelHourly.push(...parsed.modelHourly)
    } catch {
      unreadable += 1
    }
  }
  const warnings = []
  const selectedFiles = new Set(files)
  for (const file of fileCache.keys()) if (file.startsWith(sessionsDirectory + path.sep) && !selectedFiles.has(file)) fileCache.delete(file)
  if (unreadable) warnings.push(`${unreadable} 个会话日志无法读取。`)
  if (malformed) warnings.push(`${malformed} 行日志格式不完整，已跳过。`)
  if (scan.truncated) warnings.push('会话日志数量或目录层级超过扫描上限。')
  const allUsage = { ...combineUsageRows(combined), warning: warnings.join(' ') }
  if (!unreadable && !malformed) sessionCache.set(sessionsDirectory, { signature, data: allUsage })
  return selectLocalUsage(allUsage, range, now)
}

function localTimeline(range, now = new Date(), rows = []) {
  const timeline = []
  const start = new Date(now)
  if (range === 'today') {
    const end = new Date(now)
    end.setMinutes(0, 0, 0)
    start.setTime(end.getTime() - 23 * 60 * 60 * 1000)
    for (let timestamp = start.getTime(); timestamp <= end.getTime(); timestamp += 60 * 60 * 1000) timeline.push(timestamp)
    return timeline
  }
  if (range === '7d' || range === '30d') {
    const count = range === '7d' ? 7 : 30
    start.setHours(12, 0, 0, 0)
    start.setDate(start.getDate() - count + 1)
    for (let index = 0; index < count; index += 1) timeline.push(start.getTime() + index * 24 * 60 * 60 * 1000)
    return timeline
  }
  const dates = rows.map((row) => row.date).filter(Boolean).sort()
  if (!dates.length) return []
  const first = new Date(`${dates[0]}T12:00:00`)
  const last = new Date(`${dates[dates.length - 1]}T12:00:00`)
  for (let timestamp = first.getTime(); timestamp <= last.getTime(); timestamp += 24 * 60 * 60 * 1000) timeline.push(timestamp)
  return timeline
}

function localBucketKey(timestamp, hourly) {
  const date = new Date(timestamp)
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return hourly ? `${day}T${String(date.getHours()).padStart(2, '0')}` : day
}

function localRowsToModels(localUsage, range, now = new Date()) {
  const hourly = range === 'today'
  const rows = hourly ? localUsage.modelHourly : localUsage.modelDaily
  const models = new Map()
  for (const row of rows || []) {
    const dateTime = range === 'today' ? `${row.date}T${row.hour}:00` : `${row.date}T12:00:00`
    const timestamp = new Date(dateTime).getTime()
    if (!Number.isFinite(timestamp)) continue
    if (!models.has(row.model)) models.set(row.model, new Map())
    models.get(row.model).set(localBucketKey(timestamp, hourly), {
      timestamp,
      requestCount: asInt(row.requestCount),
      cachedTokens: asInt(row.cachedTokens),
      uncachedTokens: asInt(row.uncachedTokens),
      cacheWriteTokens: asInt(row.cacheWriteTokens),
      outputTokens: asInt(row.outputTokens),
      reasoningTokens: asInt(row.reasoningTokens),
      ...(row.acceleratedUsage ? { acceleratedUsage: row.acceleratedUsage } : {}),
    })
  }
  const timeline = localTimeline(range, now, rows)
  return [...models.entries()].map(([model, buckets]) => ({
    model,
    buckets: timeline.map((timestamp) => buckets.get(localBucketKey(timestamp, hourly)) || {
      timestamp,
      requestCount: 0,
      cachedTokens: 0,
      uncachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    }),
  }))
}

function combineUsageRows(data) {
  function combine(rows, fields) {
    const grouped = new Map()
    for (const row of rows) {
      const key = [row.date, row.hour, row.model].filter(Boolean).join('\u0000')
      const current = grouped.get(key) || { model: row.model, ...(row.date ? { date: row.date } : {}), ...(row.hour ? { hour: row.hour } : {}), ...emptyUsage() }
      current.requestCount += row.requestCount
      current.totalInputTokens += row.totalInputTokens
      current.uncachedInputTokens += row.uncachedTokens
      current.cacheHitTokens += row.cachedTokens
      current.cacheWriteTokens += row.cacheWriteTokens
      current.totalOutputTokens += row.outputTokens
      current.reasoningTokens += row.reasoningTokens
      mergeAcceleratedUsage(current, row.acceleratedUsage)
      grouped.set(key, current)
    }
    return [...grouped.values()].map((row) => modelRow(row.model, row, row.date, row.hour)).sort((left, right) => fields(left).localeCompare(fields(right)))
  }
  return {
    available: data.available,
    models: combine(data.models, (row) => row.model),
    modelDaily: combine(data.modelDaily, (row) => `${row.date}\u0000${row.model}`),
    modelHourly: combine(data.modelHourly, (row) => `${row.date}\u0000${row.hour}\u0000${row.model}`),
  }
}

let scannerWorker
let requestId = 0
const pendingScans = new Map()
function closeScanner() {
  const worker = scannerWorker
  scannerWorker = undefined
  for (const pending of pendingScans.values()) pending.reject(new Error('日志读取已停止。'))
  pendingScans.clear()
  return worker?.terminate()
}

function fetchLocalCodexModelUsage(range, options = {}) {
  if (!isMainThread) return scanLocalUsage(range, options)
  if (!scannerWorker) {
    const worker = scannerWorker = new Worker(__filename)
    worker.on('message', ({ id, result, error }) => {
      const pending = pendingScans.get(id)
      pendingScans.delete(id)
      if (error) pending?.reject(new Error(error)); else pending?.resolve(result)
      if (!pendingScans.size) worker.unref()
    })
    const failed = (error) => {
      if (scannerWorker !== worker) return
      scannerWorker = undefined
      for (const pending of pendingScans.values()) pending.reject(error)
      pendingScans.clear()
    }
    worker.on('error', failed)
    worker.on('exit', () => failed(new Error('本机日志读取进程已退出。')))
  }
  scannerWorker.ref()
  const id = ++requestId
  return new Promise((resolve, reject) => { pendingScans.set(id, { resolve, reject }); scannerWorker.postMessage({ id, range, options }) })
}
if (!isMainThread) {
  let queue = Promise.resolve()
  parentPort.on('message', ({ id, range, options }) => {
    queue = queue.then(() => scanLocalUsage(range, options)).then(
      (result) => parentPort.postMessage({ id, result }),
      (error) => parentPort.postMessage({ id, error: error.message }),
    )
  })
}
module.exports = { defaultCodexHome, fetchLocalCodexModelUsage, closeScanner, localRowsToModels, parseSessionText, rangeStart }
