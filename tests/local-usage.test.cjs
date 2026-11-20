const test = require('node:test')
const assert = require('node:assert/strict')
const { localRowsToModels, parseSessionText } = require('../electron/local-usage.cjs')

test('supports turn_context, official cache-write field and repeated cumulative updates', () => {
  const usage = { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 130 }
  const tokenEvent = { type: 'event_msg', timestamp: '2026-08-30T10:00:00Z', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } } }
  const data = parseSessionText([{ type: 'turn_context', payload: { model: 'gpt-5' } }, tokenEvent, tokenEvent].map(JSON.stringify).join('\n'), { range: 'all', now: new Date('2026-08-30T12:00:00Z') })
  assert.equal(data.models[0].requestCount, 1)
  assert.equal(data.models[0].cacheWriteTokens, 10)
  assert.equal(data.models[0].outputTokens, 20)
})

function threadSettings(threadSettings, threadId = 'session') {
  return { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: threadId, thread_settings: threadSettings } }
}

function turnEvent(type, turnId) {
  return { type: 'event_msg', payload: { type, turn_id: turnId } }
}

function turnContext(turnId, model = 'gpt-6.2-astra') {
  return { type: 'turn_context', payload: { model, turn_id: turnId } }
}

function tokenEvent(timestamp, usage) {
  return { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: usage } } }
}

test('uses the first mode checkpoint written after turn context and before usage', () => {
  const data = parseSessionText([
    { type: 'session_meta', payload: { id: 'session' } },
    turnEvent('task_started', 'first'),
    turnContext('first'),
    threadSettings({ model: 'gpt-6.2-astra', service_tier: 'ultrafast' }),
    tokenEvent('2026-11-18T08:00:00Z', { input_tokens: 100 }),
  ].map(JSON.stringify).join('\n'), { range: 'all', now: new Date('2026-11-18T09:00:00Z') })

  assert.equal(data.models[0].acceleratedUsage?.ultrafastPromotional.uncachedTokens, 100)
})

test('attributes local usage to the settings active for each turn and resets missing or default tiers', () => {
  const model = 'gpt-6.2-astra'
  const usage = (timestamp) => tokenEvent(timestamp, { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 20 })
  const data = parseSessionText([
    { type: 'session_meta', payload: { id: 'session' } },
    turnContext('unrecorded'),
    usage('2027-03-01T07:10:00Z'),
    threadSettings({ model, service_tier: 'priority' }),
    threadSettings({ model, service_tier: 'ultrafast' }, 'copied-parent'),
    turnEvent('task_started', 'fast'),
    threadSettings({ model, service_tier: 'ultrafast' }),
    turnContext('fast'),
    usage('2027-03-01T07:50:00Z'),
    turnContext('fast'),
    usage('2027-03-01T07:51:00Z'),
    turnEvent('task_complete', 'fast'),
    turnContext('ultrafast'),
    usage('2027-03-01T07:59:59.999Z'),
    usage('2027-03-01T08:00:00Z'),
    threadSettings({ model, service_tier: 'default' }),
    turnContext('default'),
    usage('2027-03-01T08:10:00Z'),
    threadSettings({ model, service_tier: 'fast' }),
    turnContext('another-model', 'gpt-6.2-sol'),
    usage('2027-03-01T08:20:00Z'),
    threadSettings({ model }),
    turnContext('missing'),
    usage('2027-03-01T08:30:00Z'),
  ].map(JSON.stringify).join('\n'), { range: 'all', now: new Date('2027-03-01T09:00:00Z') })

  const astra = data.models.find((row) => row.model === model)
  assert.equal(astra.requestCount, 7)
  assert.equal(astra.totalInputTokens, 770)
  assert.deepEqual(astra.acceleratedUsage, {
    fast: { cachedTokens: 80, uncachedTokens: 120, cacheWriteTokens: 20, outputTokens: 40 },
    ultrafastPromotional: { cachedTokens: 40, uncachedTokens: 60, cacheWriteTokens: 10, outputTokens: 20 },
    ultrafastList: { cachedTokens: 40, uncachedTokens: 60, cacheWriteTokens: 10, outputTokens: 20 },
  })
  assert.equal(data.models.find((row) => row.model === 'gpt-6.2-sol').acceleratedUsage, undefined)
})

test('combines accelerated local usage across cached files and forwards hourly and daily buckets', async (t) => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
  const { fetchLocalCodexModelUsage, closeScanner } = require('../electron/local-usage.cjs')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-speed-test-'))
  t.after(async () => { await closeScanner(); await fs.rm(root, { recursive: true, force: true }) })
  const model = 'gpt-6.2-sol'
  const log = (serviceTier, inputTokens) => [
    threadSettings({ model, service_tier: serviceTier }),
    turnContext('turn', model),
    tokenEvent('2027-03-02T12:10:00', { input_tokens: inputTokens }),
  ].map(JSON.stringify).join('\n')
  const options = { directory: root, now: new Date('2027-03-02T12:30:00') }
  await fs.writeFile(path.join(root, 'a.jsonl'), log('fast', 10))
  await fs.writeFile(path.join(root, 'b.jsonl'), log('ultrafast', 20))
  assert.equal((await fetchLocalCodexModelUsage('all', options)).models[0].uncachedTokens, 30)
  await fs.writeFile(path.join(root, 'c.jsonl'), log('priority', 40))
  const acceleratedUsage = {
    fast: { cachedTokens: 0, uncachedTokens: 50, cacheWriteTokens: 0, outputTokens: 0 },
    ultrafastList: { cachedTokens: 0, uncachedTokens: 20, cacheWriteTokens: 0, outputTokens: 0 },
  }
  for (const range of ['today', '7d', 'all']) {
    const data = await fetchLocalCodexModelUsage(range, options)
    const rowsByPeriod = range === 'today' ? [data.models, data.modelHourly] : [data.models, data.modelDaily, data.modelHourly]
    for (const rows of rowsByPeriod) {
      assert.equal(rows.length, 1)
      assert.equal(rows[0].requestCount, 3)
      assert.equal(rows[0].uncachedTokens, 70)
      assert.deepEqual(rows[0].acceleratedUsage, acceleratedUsage)
    }
    const [modelUsage] = localRowsToModels(data, range, options.now)
    assert.deepEqual(modelUsage.buckets.find((bucket) => bucket.requestCount > 0).acceleratedUsage, acceleratedUsage)
  }
})

test('worker scan observes appended logs and surfaces malformed lines', async (t) => {
  const fs = require('node:fs/promises')
  const path = require('node:path')
  const os = require('node:os')
  const { fetchLocalCodexModelUsage, closeScanner } = require('../electron/local-usage.cjs')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-log-test-'))
  t.after(async () => { await closeScanner(); await fs.rm(root, { recursive: true, force: true }) })
  const file = path.join(root, 'session.jsonl')
  const text = event('gpt-5', '2026-08-30T10:00:00Z', { input_tokens: 100, output_tokens: 20 })
  await fs.writeFile(file, text + '\n')
  const options = { directory: root, now: new Date('2026-08-30T12:00:00Z') }
  assert.equal((await fetchLocalCodexModelUsage('all', options)).models[0].requestCount, 1)
  await fs.appendFile(file, text + '\n{incomplete\n')
  const updated = await fetchLocalCodexModelUsage('all', options)
  assert.equal(updated.models[0].requestCount, 2)
  assert.match(updated.warning, /1 行/)
})

test('counts sessions above 64 MiB and updates cached totals after append and removal', async (t) => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
  const { fetchLocalCodexModelUsage, closeScanner } = require('../electron/local-usage.cjs')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-limits-test-'))
  t.after(async () => { await closeScanner(); await fs.rm(root, { recursive: true, force: true }) })
  await fs.writeFile(path.join(root, 'a.jsonl'), event('gpt-5', '2026-08-30T10:00:00Z', { input_tokens: 1, output_tokens: 1 }))
  const options = { directory: root, now: new Date('2026-08-30T12:00:00Z') }
  assert.equal((await fetchLocalCodexModelUsage('all', options)).warning, '')
  const oversized = path.join(root, 'b.jsonl')
  // The model follows a huge string, so limiting or inspecting only the line prefix loses usage.
  await writePaddedLog(oversized, 65, '{"type":"turn_context","payload":{"instructions":"',
    '😀","model":"gpt-5"}}\r\n' + event('gpt-5', '2026-08-30T10:00:00Z', { input_tokens: 100, output_tokens: 20 }).split('\n')[1])
  let data = await fetchLocalCodexModelUsage('all', options)
  assert.equal(data.warning, '')
  assert.equal(data.models[0].requestCount, 2)
  assert.equal(data.models[0].totalInputTokens, 101)
  // Appending also completes the previously unterminated final JSONL line.
  await fs.appendFile(oversized, '\n' + event('gpt-5', '2026-08-30T11:00:00Z', { input_tokens: 200, output_tokens: 30 }))
  data = await fetchLocalCodexModelUsage('all', options)
  assert.equal(data.models[0].requestCount, 3)
  assert.equal(data.models[0].totalInputTokens, 301)
  assert.equal(data.modelDaily.reduce((sum, row) => sum + row.requestCount, 0), 3)
  assert.equal(data.modelHourly.reduce((sum, row) => sum + row.requestCount, 0), 3)
  await fs.unlink(oversized)
  data = await fetchLocalCodexModelUsage('all', options)
  assert.equal(data.warning, '')
  assert.equal(data.models[0].requestCount, 1)
})

test('counts every session when total log size exceeds 512 MiB with a small heap', async (t) => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
  const { promisify } = require('node:util')
  const execFile = promisify(require('node:child_process').execFile)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-total-limit-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (let index = 0; index < 9; index += 1) {
    await writePaddedLog(path.join(root, `${index}.jsonl`), 58,
      '{"type":"response_item","payload":{"content":"',
      '","nested":{"type":"token_count","info":{"last_token_usage":{"input_tokens":999999}}}}}\n'
        + event('gpt-5', '2026-08-30T10:00:00Z', { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 }))
  }
  const script = `
    const { fetchLocalCodexModelUsage, closeScanner } = require(${JSON.stringify(require.resolve('../electron/local-usage.cjs'))});
    (async () => {
      try { console.log(JSON.stringify(await fetchLocalCodexModelUsage('all', { directory: process.argv[1], now: new Date('2026-08-30T12:00:00Z') }))); }
      finally { await closeScanner(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `
  const { stdout } = await execFile(process.execPath, ['--max-old-space-size=64', '-e', script, root], { timeout: 60_000 })
  const data = JSON.parse(stdout)
  assert.equal(data.warning, '')
  assert.equal(data.models[0].requestCount, 9)
  assert.equal(data.models[0].totalInputTokens, 90)
  assert.equal(data.models[0].cachedTokens, 36)
  assert.equal(data.models[0].outputTokens, 18)
})

async function writePaddedLog(file, mebibytes, prefix, suffix) {
  const fs = require('node:fs/promises')
  const handle = await fs.open(file, 'w')
  try {
    await handle.writeFile(prefix)
    const block = Buffer.alloc(1024 * 1024, 'x')
    for (let index = 0; index < mebibytes; index += 1) await handle.writeFile(block)
    await handle.writeFile(suffix)
  } finally { await handle.close() }
}

test('streams usage fields in long reordered records and recovers after a malformed long line', async (t) => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
  const { fetchLocalCodexModelUsage, closeScanner } = require('../electron/local-usage.cjs')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-long-record-test-'))
  t.after(async () => { await closeScanner(); await fs.rm(root, { recursive: true, force: true }) })
  const file = path.join(root, 'long.jsonl')
  const padding = 'x'.repeat(300_000)
  const usage = { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 130 }
  const longToken = { payload: { padding, info: { last_token_usage: usage, total_token_usage: usage }, type: 'token_count' }, timestamp: '2026-08-30T10:00:00Z', type: 'event_msg' }
  await fs.writeFile(file, [
    JSON.stringify({ payload: { padding, id: 'session' }, type: 'session_meta' }),
    JSON.stringify(threadSettings({ padding, model: 'gpt-6.2-astra', service_tier: 'ultrafast' })),
    JSON.stringify(threadSettings({ padding, model: 'gpt-6.2-astra', service_tier: 'fast' }, 'copied-parent')),
    JSON.stringify({ payload: { padding, state: { collaboration_mode: { settings: { model: 'gpt-6.2-astra' } } } }, type: 'world_state' }),
    JSON.stringify(longToken),
    JSON.stringify(longToken), // Keep cumulative-usage deduplication across streamed records.
    '{"payload":{"padding":"' + padding + '\\q"}}',
    JSON.stringify({ payload: { padding, collaboration_mode: { settings: { model: 'o3-mini' } } }, type: 'turn_context' }),
    event('o3-mini', '2026-08-30T11:00:00Z', { input_tokens: 30, output_tokens: 7 }).split('\n')[1],
  ].join('\r\n'))
  const options = { directory: root, now: new Date('2026-08-30T12:00:00Z') }
  let data = await fetchLocalCodexModelUsage('all', options)
  assert.match(data.warning, /1 行/)
  assert.equal(data.models.reduce((sum, row) => sum + row.requestCount, 0), 2)
  const gpt = data.models.find((row) => row.model === 'gpt-6.2-astra')
  assert.equal(gpt.totalInputTokens, 110)
  assert.equal(gpt.cachedTokens, 40)
  assert.equal(gpt.cacheWriteTokens, 10)
  assert.equal(gpt.outputTokens, 20)
  assert.equal(gpt.reasoningTokens, 5)
  assert.deepEqual(gpt.acceleratedUsage, {
    ultrafastPromotional: { cachedTokens: 40, uncachedTokens: 60, cacheWriteTokens: 10, outputTokens: 20 },
  })
  assert.equal(data.models.find((row) => row.model === 'o3-mini').totalInputTokens, 30)
  data = await fetchLocalCodexModelUsage('all', { ...options, force: true })
  assert.equal(data.models.reduce((sum, row) => sum + row.requestCount, 0), 2)
  assert.match(data.warning, /1 行/)
})

function event(model, timestamp, usage) {
  return [
    JSON.stringify({ type: 'world_state', payload: { state: { collaboration_mode: { model } } } }),
    JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: usage } } }),
  ].join('\n')
}

test('parses Codex session token events by model and time bucket', () => {
  const text = [
    event('gpt-5.6-terra', '2026-08-30T09:30:00Z', {
      input_tokens: 100,
      cached_input_tokens: 60,
      cache_write_tokens: 4,
      output_tokens: 20,
      reasoning_output_tokens: 5,
    }),
    event('muse-spark-1.2', '2026-08-30T10:30:00Z', {
      input_tokens: 999,
      output_tokens: 999,
    }),
    event('gpt-5.6-sol', '2026-08-29T10:30:00Z', {
      input_tokens: 50,
      cached_input_tokens: 0,
      output_tokens: 10,
      reasoning_output_tokens: 2,
    }),
  ].join('\n')

  const data = parseSessionText(text, { range: '7d', now: new Date('2026-08-30T12:00:00Z') })
  assert.deepEqual(data.models.map((row) => row.model), ['gpt-5.6-terra', 'gpt-5.6-sol'])
  assert.deepEqual(data.models[0], {
    model: 'gpt-5.6-terra',
    requestCount: 1,
    cachedTokens: 60,
    uncachedTokens: 40,
    cacheWriteTokens: 4,
    outputTokens: 20,
    totalInputTokens: 104,
    reasoningTokens: 5,
  })
  assert.equal(data.modelDaily.length, 2)
  assert.equal(data.modelHourly.length, 2)
})

test('uses hourly rows for today and ignores malformed events', () => {
  const data = parseSessionText([
    '{not-json}',
    event('gpt-5.6-luna', '2026-08-30T11:30:00Z', { input_tokens: 20, output_tokens: 5 }),
    event('gpt-5.6-luna', '2026-08-28T11:30:00Z', { input_tokens: 20, output_tokens: 5 }),
  ].join('\n'), { range: 'today', now: new Date('2026-08-30T12:00:00Z') })

  assert.equal(data.models[0].model, 'gpt-5.6-luna')
  assert.equal(data.models[0].requestCount, 1)
  assert.equal(data.modelHourly.length, 1)
})

test('accepts OpenAI o-series models but ignores other providers', () => {
  const data = parseSessionText([
    event('o3-mini', '2026-08-30T11:30:00Z', { input_tokens: 20, output_tokens: 5 }),
    event('claude-3-7-sonnet', '2026-08-30T11:30:00Z', { input_tokens: 999, output_tokens: 999 }),
  ].join('\n'), { range: 'today', now: new Date('2026-08-30T12:00:00Z') })

  assert.deepEqual(data.models.map((row) => row.model), ['o3-mini'])
})

test('fills missing daily model buckets with zeroes', () => {
  const models = localRowsToModels({
    modelDaily: [{ model: 'gpt-5.6-terra', date: '2026-08-29', requestCount: 3, cachedTokens: 10, uncachedTokens: 20, cacheWriteTokens: 0, outputTokens: 5 }],
  }, '7d', new Date('2026-08-30T12:00:00'))

  assert.equal(models.length, 1)
  assert.equal(models[0].buckets.length, 7)
  assert.equal(models[0].buckets.filter((bucket) => bucket.requestCount > 0).length, 1)
  assert.equal(models[0].buckets.reduce((sum, bucket) => sum + bucket.requestCount, 0), 3)
})

test('uses a rolling 24-hour window for hourly model buckets', () => {
  const models = localRowsToModels({
    modelHourly: [{ model: 'gpt-5.6-terra', date: '2026-08-30', hour: '12:00', requestCount: 1, cachedTokens: 0, uncachedTokens: 10, cacheWriteTokens: 0, outputTokens: 5 }],
  }, 'today', new Date('2026-08-30T12:37:00'))

  assert.equal(models.length, 1)
  assert.equal(models[0].buckets.length, 24)
  assert.equal(models[0].buckets.at(-1).requestCount, 1)
})
