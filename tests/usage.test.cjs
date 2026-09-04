const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeApiBuckets, normalizeSubscriptionPayload, rangeWindow } = require('../electron/usage.cjs')

test('normalizes and aggregates API usage by model and bucket', () => {
  const snapshot = normalizeApiBuckets([
    {
      start_time: 1700000000,
      results: [
        { model: 'gpt-test', num_model_requests: 2, input_tokens: 100, input_cached_tokens: 40, input_uncached_tokens: 60, output_tokens: 20 },
        { model: 'gpt-test', num_model_requests: 1, input_tokens: 25, input_cached_tokens: 25, input_uncached_tokens: 0, output_tokens: 8 },
      ],
    },
  ], { start: 0, end: 0 })

  assert.deepEqual(snapshot.models[0].model, 'gpt-test')
  assert.deepEqual(snapshot.models[0].buckets[0], {
    timestamp: 1700000000000,
    requestCount: 3,
    cachedTokens: 65,
    uncachedTokens: 60,
    reasoningTokens: 0,
    outputTokens: 28,
  })
})

test('falls back to input token difference when uncached count is omitted', () => {
  const snapshot = normalizeApiBuckets([
    { start_time: 1700000000, results: [{ model: 'gpt-test', input_tokens: 100, input_cached_tokens: 25 }] },
  ], { start: 0, end: 0 })

  assert.equal(snapshot.models[0].buckets[0].uncachedTokens, 75)
})

test('keeps OpenAI model ids and excludes other providers', () => {
  const snapshot = normalizeApiBuckets([
    {
      start_time: 1700000000,
      results: [
        { model: 'o3', num_model_requests: 1, input_tokens: 12 },
        { model: 'ft:gpt-4o-mini:org-example', num_model_requests: 1, input_tokens: 8 },
        { model: 'claude-3-7-sonnet', num_model_requests: 9, input_tokens: 999 },
      ],
    },
  ], { start: 0, end: 0 })

  assert.deepEqual(snapshot.models.map((model) => model.model), ['o3', 'ft:gpt-4o-mini:org-example'])
})

test('normalizes subscription rate limit windows without fabricating history', () => {
  const details = normalizeSubscriptionPayload({
    plan_type: 'pro',
    account_id: 'account-1',
    rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1700001000 },
      secondary_window: { used_percent: 28, limit_window_seconds: 604800, reset_at: 1700605800 },
    },
  }, 'fallback-account')

  assert.equal(details.planType, 'pro')
  assert.equal(details.accountId, 'account-1')
  assert.equal(details.windows.length, 2)
  assert.equal(details.windows[0].usedPercent, 12)
  assert.equal(details.windows[0].label, '5 小时额度')
  assert.equal(details.windows[1].label, '周额度')
})

test('rejects an incompatible subscription response', () => {
  assert.throws(
    () => normalizeSubscriptionPayload({ plan_type: 'pro', unexpected_field: true }, 'account-1'),
    /响应结构不兼容/,
  )
  assert.throws(
    () => normalizeSubscriptionPayload({ rate_limit: { primary_window: 'changed' } }, 'account-1'),
    /响应结构不兼容/,
  )
  assert.throws(
    () => normalizeSubscriptionPayload({ additional_rate_limits: [null] }, 'account-1'),
    /响应结构不兼容/,
  )
})

test('selects hourly API buckets only for today', () => {
  assert.equal(rangeWindow('today').bucketWidth, '1h')
  assert.equal(rangeWindow('7d').bucketWidth, '1d')
})

test('fills missing API daily buckets for the selected range', () => {
  const end = new Date('2026-08-30T12:00:00').getTime() / 1000
  const start = new Date('2026-08-24T00:00:00').getTime() / 1000
  const snapshot = normalizeApiBuckets([
    { start_time: new Date('2026-08-29T12:00:00').getTime() / 1000, results: [{ model: 'gpt-5', num_model_requests: 3 }] },
  ], { start, end, bucketWidth: '1d' }, '7d')

  assert.equal(snapshot.models.length, 1)
  assert.equal(snapshot.models[0].buckets.length, 7)
  assert.equal(snapshot.models[0].buckets.filter((bucket) => bucket.requestCount > 0).length, 1)
})
