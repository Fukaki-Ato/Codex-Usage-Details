import type {
  ModelUsage,
  UsageAccount,
  UsageBucket,
  UsageRange,
  UsageSnapshot,
  UsageSource,
} from './types'

export const accounts: UsageAccount[] = [
  {
    id: 'api-production',
    name: 'Production API',
    detail: '组织管理员账户',
    sources: ['api'],
    status: 'connected',
  },
  {
    id: 'api-personal',
    name: 'Personal API',
    detail: '个人 API 账户',
    sources: ['api'],
    status: 'connected',
  },
  {
    id: 'chatgpt-pro',
    name: 'ChatGPT Pro',
    detail: '订阅账户',
    sources: ['subscription'],
    status: 'connected',
  },
  {
    id: 'chatgpt-team',
    name: 'ChatGPT Team',
    detail: '团队订阅账户',
    sources: ['subscription'],
    status: 'needs-auth',
  },
]

const modelNames = ['gpt-5', 'gpt-5-mini', 'gpt-4.1']

const rangeConfig: Record<UsageRange, { count: number; interval: number; base: number }> = {
  today: { count: 24, interval: 60 * 60 * 1000, base: 18 },
  '7d': { count: 7, interval: 24 * 60 * 60 * 1000, base: 92 },
  '30d': { count: 30, interval: 24 * 60 * 60 * 1000, base: 280 },
  all: { count: 90, interval: 24 * 60 * 60 * 1000, base: 520 },
}

function hash(value: string) {
  let result = 0
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) % 997
  }
  return result
}

function createBucket(
  accountId: string,
  source: UsageSource,
  range: UsageRange,
  modelIndex: number,
  index: number,
): UsageBucket {
  const config = rangeConfig[range]
  const seed = hash(`${accountId}-${source}-${range}-${modelIndex}`)
  const modelFactor = [1.55, 0.92, 0.68][modelIndex]
  const wave = 0.74 + ((seed + index * 17) % 43) / 100
  const sourceFactor = source === 'subscription' ? 0.86 : 1
  const requestCount = Math.max(1, Math.round(config.base * modelFactor * wave * sourceFactor))
  const cachedRatio = 0.42 + ((seed + index * 7) % 25) / 100
  const cachedTokens = Math.round(requestCount * (range === 'today' ? 720 : 1050) * cachedRatio)
  const uncachedTokens = Math.round(requestCount * (range === 'today' ? 910 : 1320) * (1 - cachedRatio))
  const outputTokens = Math.round(requestCount * (range === 'today' ? 430 : 680) * (0.82 + (seed % 14) / 100))

  const now = new Date()
  if (range === 'today') {
    now.setMinutes(0, 0, 0)
  } else {
    now.setHours(12, 0, 0, 0)
  }

  return {
    timestamp: now.getTime() - (config.count - index - 1) * config.interval,
    requestCount,
    cachedTokens,
    uncachedTokens,
    outputTokens,
  }
}

export function createDemoSnapshot(
  accountId: string,
  source: UsageSource,
  range: UsageRange,
): UsageSnapshot {
  const models: ModelUsage[] = modelNames.map((model, modelIndex) => ({
    model,
    buckets: Array.from({ length: rangeConfig[range].count }, (_, index) =>
      createBucket(accountId, source, range, modelIndex, index),
    ),
  }))

  return {
    accountId,
    source,
    range,
    models,
    updatedAt: Date.now(),
    mode: 'demo',
    ...(source === 'subscription' ? {
      subscription: {
        planType: 'Pro',
        accountId: 'demo-account',
        userId: null,
        windows: [
          { label: '5 小时额度', usedPercent: 15, limitWindowSeconds: 18_000, resetsAt: Date.now() + 1.8 * 60 * 60 * 1000, resetAfterSeconds: 6_480 },
          { label: '周额度', usedPercent: 28, limitWindowSeconds: 604_800, resetsAt: Date.now() + 5.2 * 24 * 60 * 60 * 1000, resetAfterSeconds: 449_280 },
        ],
      },
    } : {}),
  }
}
