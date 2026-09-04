const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { isOpenAiModel } = require('./models.cjs')

const MAX_SESSION_FILES = 10_000
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024
const MAX_SESSION_TOTAL_BYTES = 512 * 1024 * 1024
const MAX_SESSION_DEPTH = 32

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

const sessionCache = new Map()

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

function addUsage(target, usage) {
  const inputTokens = asInt(usage?.input_tokens)
  const cacheHitTokens = Math.min(inputTokens, asInt(usage?.cached_input_tokens))
  const cacheWriteTokens = asInt(usage?.cache_write_tokens)
  const outputTokens = asInt(usage?.output_tokens)
  const reasoningTokens = asInt(usage?.reasoning_output_tokens)
  if (!inputTokens && !outputTokens && !reasoningTokens) return false
  target.requestCount += 1
  target.totalInputTokens += inputTokens + cacheWriteTokens
  target.uncachedInputTokens += inputTokens - cacheHitTokens
  target.cacheHitTokens += cacheHitTokens
  target.cacheWriteTokens += cacheWriteTokens
  target.totalOutputTokens += outputTokens
  target.reasoningTokens += reasoningTokens
  return true
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
  return row
}

function parseSessionText(text, { range = '7d', now = new Date() } = {}) {
  const start = rangeStart(range, now)
  const models = new Map()
  const daily = new Map()
  const hourly = new Map()
  let currentModel = ''

  for (const line of String(text).split(/\r?\n/)) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const payload = event?.payload || {}
    if (event?.type === 'world_state') {
      const model = payload?.state?.collaboration_mode?.model
      currentModel = isOpenAiModel(model) ? model.trim() : ''
      continue
    }
    if (event?.type !== 'event_msg' || payload.type !== 'token_count' || !currentModel) continue
    const timestamp = new Date(event.timestamp)
    if (Number.isNaN(timestamp.getTime()) || (start && timestamp < start)) continue
    const usage = payload?.info?.last_token_usage
    if (!usage || typeof usage !== 'object') continue
    const local = new Date(timestamp.getTime())
    const date = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
    const hour = `${String(local.getHours()).padStart(2, '0')}:00`
    if (!addUsage(models.get(currentModel) || models.set(currentModel, emptyUsage()).get(currentModel), usage)) continue
    const dailyKey = `${date}\u0000${currentModel}`
    const hourlyKey = `${date}\u0000${hour}\u0000${currentModel}`
    addUsage(daily.get(dailyKey) || daily.set(dailyKey, emptyUsage()).get(dailyKey), usage)
    addUsage(hourly.get(hourlyKey) || hourly.set(hourlyKey, emptyUsage()).get(hourlyKey), usage)
  }

  const modelRows = [...models.entries()]
    .map(([model, values]) => modelRow(model, values))
    .sort((left, right) => right.totalInputTokens + right.outputTokens + right.reasoningTokens - left.totalInputTokens - left.outputTokens - left.reasoningTokens)
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

  return { available: true, models: modelRows, modelDaily: dailyRows, modelHourly: hourlyRows }
}

async function listJsonlFiles(directory) {
  const files = []
  let skippedFiles = 0
  let totalBytes = 0
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
      let size
      try {
        size = (await fs.stat(entryPath)).size
      } catch {
        continue
      }
      if (size > MAX_SESSION_FILE_BYTES || totalBytes + size > MAX_SESSION_TOTAL_BYTES) {
        skippedFiles += 1
        continue
      }
      totalBytes += size
      files.push(entryPath)
    }
  }

  await visit(directory, 0)
  return { files, skippedFiles, truncated }
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

async function fetchLocalCodexModelUsage(range, { directory, codexHome, force = false, now = new Date() } = {}) {
  const sessionsDirectory = directory || path.join(codexHome || defaultCodexHome(), 'sessions')
  let scan
  try {
    scan = await listJsonlFiles(sessionsDirectory)
  } catch (error) {
    if (error.code === 'ENOENT') return { available: false, models: [], modelDaily: [], modelHourly: [] }
    throw error
  }
  const { files } = scan
  const signature = await sessionSignature(files)
  const cached = sessionCache.get(sessionsDirectory)
  if (!force && cached?.signature === signature) return selectLocalUsage(cached.data, range, now)

  const combined = { available: true, models: [], modelDaily: [], modelHourly: [] }
  for (const file of files) {
    try {
      const parsed = parseSessionText(await fs.readFile(file, 'utf8'), { range: 'all', now })
      combined.models.push(...parsed.models)
      combined.modelDaily.push(...parsed.modelDaily)
      combined.modelHourly.push(...parsed.modelHourly)
    } catch {
      // A partially written or inaccessible session file should not hide other sessions.
    }
  }
  const warnings = []
  if (scan.skippedFiles) warnings.push(`已跳过 ${scan.skippedFiles} 个过大的会话日志文件。`)
  if (scan.truncated) warnings.push('会话日志数量或目录层级超过扫描上限。')
  const allUsage = { ...combineUsageRows(combined), warning: warnings.join(' ') }
  sessionCache.set(sessionsDirectory, { signature, data: allUsage })
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

module.exports = { defaultCodexHome, fetchLocalCodexModelUsage, localRowsToModels, parseSessionText, rangeStart }
