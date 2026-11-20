require('./ts-loader.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { pricingForModel, estimateModelCost, estimateSnapshotCost } = require('../src/pricing.ts')
const { sumBuckets, aggregateBuckets } = require('../src/usage-utils.ts')
const bucket = { timestamp: Date.now(), requestCount: 1, cachedTokens: 40, uncachedTokens: 60, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 5 }

test('reasoning is a subset of output in both totals and cost', () => {
  assert.equal(sumBuckets([bucket]).tokens, 120)
  assert.equal(estimateModelCost({ model: 'gpt-5', buckets: [bucket] }).amount, (60 * 1.25 + 40 * 0.125 + 20 * 10) / 1e6)
})
test('dated nano snapshots retain their own pricing; unknown variants stay unknown', () => {
  assert.deepEqual(pricingForModel('gpt-5.4-nano-2026-03-17'), pricingForModel('gpt-5.4-nano'))
  for (const model of ['gpt-5.4-unknown', 'gpt-6-terra', 'gpt-6.1-luna', 'gpt-6.1-sol-unknown', 'gpt-4o-audio-preview', 'ft:gpt-4o:custom', '__proto__']) assert.equal(pricingForModel(model), null)
})

const gpt6ModelPrices = [
  ['gpt-6.2-astra', [8, 0.4, 10, 40], 257.2],
  ['gpt-6.2-sol', [2, 0.1, 2.5, 10], 64.3],
  ['gpt-6-astra', [10, 1, 12.5, 50], 323],
  ['gpt-6.1-sol', [2, 0.1, 2.5, 10], 64.3],
  ['gpt-6.1-terra', [1, 0.05, 1.25, 5], 32.15],
  ['gpt-6-luna', [0.1, 0.01, 0.125, 0.5], 3.23],
  ['gpt-6-sol', [2, 0.2, 2.5, 10], 64.6],
]
const emptyBucket = { ...bucket, uncachedTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 }

for (const [model, prices, mixedCost] of gpt6ModelPrices) {
  test(`${model} prices input, cached input, cache writes and output separately`, () => {
    const fields = ['uncachedTokens', 'cachedTokens', 'cacheWriteTokens', 'outputTokens']
    for (const [index, field] of fields.entries()) {
      const result = estimateModelCost({ model, buckets: [{ ...emptyBucket, [field]: 1_000_000 }] })
      assert.ok(result, `${model}: ${field} must have a price`)
      assert.equal(result.amount, prices[index], field)
    }
    const buckets = fields.map((field, index) => ({ ...emptyBucket, [field]: (index + 2) * 1_000_000 }))
    assert.ok(Math.abs(estimateModelCost({ model, buckets }).amount - mixedCost) < 1e-10)
  })
}

test('GPT-6.2 mixes Standard, Fast and each Ultrafast price within one bucket', () => {
  const usage = { cachedTokens: 1_000_000, uncachedTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 }
  const mixed = {
    ...bucket,
    cachedTokens: 4_000_000,
    uncachedTokens: 4_000_000,
    cacheWriteTokens: 4_000_000,
    outputTokens: 4_000_000,
    acceleratedUsage: { fast: usage, ultrafastPromotional: usage, ultrafastList: usage },
  }
  for (const [model, expected] of [['gpt-6.2-astra-2026-11-17', 700.80], ['gpt-6.2-sol', 175.20]]) {
    const result = estimateModelCost({ model, buckets: [mixed] })
    assert.ok(Math.abs(result.amount - expected) < 1e-10)
    assert.deepEqual(result.appliedRates.map(({ multiplier }) => multiplier), [2, 3, 6])
  }
})

test('prices recorded 12-hour cache writes at the GPT-6.2 speed rate', () => {
  const { normalizeApiBuckets } = require('../electron/usage.cjs')
  const model = 'gpt-6.2-sol'
  const { models } = normalizeApiBuckets([{
    start_time: Date.parse('2026-11-18T08:00:00Z') / 1000,
    results: [
      { model, service_tier: 'fast', input_cache_write_tokens: 2_000_000, input_cache_write_12h_tokens: 1_000_000 },
      { model, service_tier: 'ultrafast', input_cache_write_tokens: 1_000_000, input_cache_write_12h_tokens: 1_000_000 },
    ],
  }], { start: 0, end: 0, bucketWidth: '1h' })

  assert.equal(sumBuckets(models[0].buckets).tokens, 3_000_000)
  assert.equal(estimateModelCost(models[0]).amount, 30)
})

test('dated 6.1 Sol snapshots inherit pricing without charging reasoning twice', () => {
  const usage = { model: 'gpt-6.1-sol-2026-11-01', buckets: [{ ...bucket, cacheWriteTokens: 30 }] }
  assert.deepEqual(pricingForModel(usage.model), pricingForModel('gpt-6.1-sol'))
  assert.equal(estimateModelCost(usage).amount, 399 / 1e6)
  assert.equal(estimateModelCost({ ...usage, buckets: [{ ...usage.buckets[0], reasoningTokens: 0 }] }).amount, 399 / 1e6)
})

test('older models without cache write pricing remain explicitly unpriced when writes occur', () => {
  assert.equal(estimateModelCost({ model: 'gpt-5', buckets: [{ ...bucket, cacheWriteTokens: 1 }] }), null)
})

test('historical Codex models retain explicit rates, dated snapshots and unknown write prices', () => {
  for (const [model, amount] of [
    ['gpt-5-codex', 280],
    ['gpt-5.1-codex', 280],
    ['gpt-5.1-codex-max', 280],
    ['gpt-5.1-codex-mini', 56],
    ['gpt-5.2-codex', 392],
  ]) {
    const usage = { model: `${model}-2026-01-01`, buckets: [bucket] }
    assert.deepEqual(pricingForModel(usage.model), pricingForModel(model))
    assert.equal(estimateModelCost(usage).amount, amount / 1e6)
    assert.equal(estimateModelCost({ model, buckets: [{ ...bucket, cacheWriteTokens: 1 }] }), null)
  }
})

test('snapshot totals include all priced GPT-6 models without missing prices', () => {
  const buckets = [{ ...bucket, uncachedTokens: 1_000_000, cachedTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 }]
  const result = estimateSnapshotCost(gpt6ModelPrices.map(([model]) => ({ model, buckets })))
  assert.deepEqual(result.unknownModels, [])
  assert.equal(result.byModel.length, gpt6ModelPrices.length)
  assert.ok(Math.abs(result.amount - 183.835) < 1e-10)
})
test('partial cost estimates retain explicit unknown models', () => {
  const result = estimateSnapshotCost([{ model: 'gpt-5', buckets: [bucket] }, { model: 'gpt-future', buckets: [bucket] }])
  assert.deepEqual(result.unknownModels, ['gpt-future'])
  assert.equal(result.amount, estimateModelCost({ model: 'gpt-5', buckets: [bucket] }).amount)
})
test('long history aggregation preserves totals and chronological order', () => {
  const rows = Array.from({ length: 3650 }, (_, index) => ({ ...bucket, timestamp: new Date(2016, 0, 1 + index).getTime() }))
  const result = aggregateBuckets(rows)
  assert.ok(result.buckets.length < 60)
  assert.deepEqual(sumBuckets(result.buckets), sumBuckets(rows))
  assert.ok(result.buckets.every((item, i, all) => !i || item.timestamp > all[i - 1].timestamp))
})
