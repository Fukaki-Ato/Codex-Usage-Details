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

test('unchanged selected files cannot hide new scan-limit warnings', async (t) => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
  const { fetchLocalCodexModelUsage, closeScanner } = require('../electron/local-usage.cjs')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-limits-test-'))
  t.after(async () => { await closeScanner(); await fs.rm(root, { recursive: true, force: true }) })
  await fs.writeFile(path.join(root, 'a.jsonl'), event('gpt-5', '2026-08-30T10:00:00Z', { input_tokens: 1, output_tokens: 1 }))
  const options = { directory: root, now: new Date('2026-08-30T12:00:00Z') }
  assert.equal((await fetchLocalCodexModelUsage('all', options)).warning, '')
  const oversized = path.join(root, 'b.jsonl')
  const handle = await fs.open(oversized, 'w'); await handle.truncate(65 * 1024 * 1024); await handle.close()
  assert.match((await fetchLocalCodexModelUsage('all', options)).warning, /已跳过 1/)
  await fs.unlink(oversized)
  assert.equal((await fetchLocalCodexModelUsage('all', options)).warning, '')
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
