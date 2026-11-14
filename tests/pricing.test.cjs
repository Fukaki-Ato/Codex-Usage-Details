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
  for (const model of ['gpt-5.4-unknown', 'gpt-4o-audio-preview', 'ft:gpt-4o:custom', '__proto__']) assert.equal(pricingForModel(model), null)
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
