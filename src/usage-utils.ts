import type { UsageBucket } from './types'

export function totalTokens(bucket: UsageBucket) {
  return bucket.cachedTokens + bucket.uncachedTokens + (bucket.cacheWriteTokens || 0) + bucket.outputTokens
}

export function sumBuckets(buckets: UsageBucket[]) {
  return buckets.reduce((sum, bucket) => ({
    requests: sum.requests + bucket.requestCount,
    tokens: sum.tokens + totalTokens(bucket),
    cached: sum.cached + bucket.cachedTokens,
    input: sum.input + bucket.cachedTokens + bucket.uncachedTokens + (bucket.cacheWriteTokens || 0),
  }), { requests: 0, tokens: 0, cached: 0, input: 0 })
}

export function aggregateBuckets(buckets: UsageBucket[]) {
  if (buckets.length <= 60) return { buckets, label: '原始时间分桶' }
  const mode = buckets.length <= 366 ? 'week' : buckets.length <= 1800 ? 'month' : 'quarter'
  const groups = new Map<number, UsageBucket>()
  for (const bucket of buckets) {
    const date = new Date(bucket.timestamp)
    date.setHours(0, 0, 0, 0)
    if (mode === 'week') date.setDate(date.getDate() - (date.getDay() + 6) % 7)
    else { date.setDate(1); if (mode === 'quarter') date.setMonth(Math.floor(date.getMonth() / 3) * 3) }
    const key = date.getTime()
    const current = groups.get(key) || { timestamp: key, requestCount: 0, cachedTokens: 0, uncachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 }
    for (const field of ['requestCount', 'cachedTokens', 'uncachedTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens'] as const) current[field] = (current[field] || 0) + (bucket[field] || 0)
    current.endTimestamp = bucket.timestamp
    groups.set(key, current)
  }
  return { buckets: [...groups.values()].sort((a, b) => a.timestamp - b.timestamp), label: mode === 'week' ? '按周汇总' : mode === 'month' ? '按月汇总' : '按季度汇总' }
}
