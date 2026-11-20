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

test('keeps actual service tiers and cache writes within a single API time bucket', () => {
  const model = 'gpt-6.2-sol'
  const snapshot = normalizeApiBuckets([{
    start_time: Date.parse('2026-11-18T06:00:00Z') / 1000,
    results: [
      { model, service_tier: 'default', num_model_requests: 1, input_tokens: 100, output_tokens: 12 },
      { model, service_tier: 'priority', num_model_requests: 2, input_tokens: 80, input_cached_tokens: 20, input_cache_write_tokens: 10, output_tokens: 22 },
      { model, service_tier: 'fast', num_model_requests: 1, input_tokens: 45, input_uncached_tokens: 35, input_cache_write_30m_tokens: 6, input_cache_write_12h_tokens: 4, output_tokens: 5 },
      { model, service_tier: 'ultrafast', num_model_requests: 1, input_tokens: 115, input_cached_tokens: 15, output_tokens: 8 },
      { model, num_model_requests: 1, input_tokens: 55, output_tokens: 4 },
    ],
  }], { start: 0, end: 0, bucketWidth: '1h' })

  assert.equal(snapshot.models.length, 1)
  assert.equal(snapshot.models[0].buckets.length, 1)
  const { timestamp, reasoningTokens, ...bucket } = snapshot.models[0].buckets[0]
  assert.deepEqual(bucket, {
    requestCount: 6,
    cachedTokens: 35,
    uncachedTokens: 340,
    cacheWriteTokens: 20,
    cacheWrite12hTokens: 4,
    outputTokens: 51,
    acceleratedUsage: {
      fast: { cachedTokens: 20, uncachedTokens: 85, cacheWriteTokens: 20, cacheWrite12hTokens: 4, outputTokens: 27 },
      ultrafastPromotional: { cachedTokens: 15, uncachedTokens: 100, cacheWriteTokens: 0, outputTokens: 8 },
    },
  })
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
    plan_type: 'plus',
    account_id: 'account-1',
    rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1700001000 },
      secondary_window: { used_percent: 28, limit_window_seconds: 604800, reset_at: 1700605800 },
    },
  }, 'fallback-account')

  assert.equal(details.planType, 'plus')
  assert.equal(details.accountId, 'account-1')
  assert.equal(details.windows.length, 2)
  assert.equal(details.windows[0].usedPercent, 12)
  assert.equal(details.windows[0].label, '5 小时额度')
  assert.equal(details.windows[1].label, '周额度')
})

const fiveHourWindow = { used_percent: 12, limit_window_seconds: 18000, reset_at: 1700001000 }
const weeklyWindow = { used_percent: 28, limit_window_seconds: 604800, reset_at: 1700605800 }

test('Pro tiers discard obsolete five-hour limits and retain the actual weekly window', () => {
  for (const plan of ['pro', 'PRO', ' Pro ', 'pro100', 'Pro 100', 'PRO_200', 'pro-500', 'pRo  200']) {
    const details = normalizeSubscriptionPayload({
      plan_type: plan,
      rate_limit: { primary_window: fiveHourWindow, secondary_window: weeklyWindow },
    }, 'account-1')
    assert.equal(details.planType, plan)
    assert.deepEqual(details.windows.map(({ id, label, usedPercent, resetsAt }) => ({ id, label, usedPercent, resetsAt })), [
      { id: 'secondary', label: '周额度', usedPercent: 28, resetsAt: 1700605800000 },
    ], plan)
  }
})

test('Pro accepts a null primary window and retains weekly usage in either slot', () => {
  for (const rate_limit of [
    { primary_window: null, secondary_window: weeklyWindow },
    { primary_window: weeklyWindow, secondary_window: null },
    { primary_window: weeklyWindow, secondary_window: fiveHourWindow },
  ]) {
    const details = normalizeSubscriptionPayload({ plan_type: 'pro', rate_limit }, 'account-1')
    assert.equal(details.windows.length, 1)
    assert.equal(details.windows[0].label, '周额度')
    assert.equal(details.windows[0].usedPercent, 28)
    assert.equal(details.windows[0].resetsAt, 1700605800000)
  }
})

test('Pro preserves other returned quota durations', () => {
  const details = normalizeSubscriptionPayload({
    plan_type: 'pro-100',
    rate_limit: { primary_window: fiveHourWindow, secondary_window: { ...weeklyWindow, limit_window_seconds: 86400 } },
  }, 'account-1')
  assert.equal(details.windows.length, 1)
  assert.equal(details.windows[0].label, '24 小时额度')
  assert.equal(details.windows[0].usedPercent, 28)
})

test('Pro without a current quota window returns no fabricated weekly usage', () => {
  for (const rate_limit of [
    { primary_window: fiveHourWindow },
    { primary_window: null, secondary_window: fiveHourWindow },
    { primary_window: null, secondary_window: null },
  ]) {
    const details = normalizeSubscriptionPayload({ plan_type: 'pro_500', rate_limit }, 'account-1')
    assert.deepEqual(details.windows, [])
  }
})

test('unknown and non-Pro plans keep five-hour limits and reject all-null windows', () => {
  for (const plan_type of [undefined, 'unknown', 'plus', 'business_pro', 'enterprise', 'professional', 'pro-300', 'pro1000']) {
    const details = normalizeSubscriptionPayload({ plan_type, rate_limit: { primary_window: fiveHourWindow, secondary_window: weeklyWindow } }, 'account-1')
    assert.equal(details.windows.length, 2, String(plan_type))
    assert.equal(details.windows[0].label, '5 小时额度')
    assert.throws(() => normalizeSubscriptionPayload({ plan_type, rate_limit: { primary_window: null, secondary_window: null } }, 'account-1'), /响应结构不兼容/)
  }
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
