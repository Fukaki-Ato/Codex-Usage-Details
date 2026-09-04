const test = require('node:test')
const assert = require('node:assert/strict')
const { localRowsToModels, parseSessionText } = require('../electron/local-usage.cjs')

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
