export type UsageSource = 'api' | 'subscription'
export type UsageRange = 'today' | '7d' | '30d' | 'all'

export interface UsageTokenCounts {
  cachedTokens: number
  uncachedTokens: number
  cacheWriteTokens?: number
  cacheWrite12hTokens?: number
  outputTokens: number
}

export type AcceleratedRate = 'fast' | 'ultrafastPromotional' | 'ultrafastList'

export interface UsageBucket extends UsageTokenCounts {
  timestamp: number
  requestCount: number
  reasoningTokens?: number
  endTimestamp?: number
  acceleratedUsage?: Partial<Record<AcceleratedRate, UsageTokenCounts>>
}

export interface ModelUsage {
  model: string
  buckets: UsageBucket[]
}

export interface UsageAccount {
  id: string
  name: string
  detail: string
  sources: UsageSource[]
  status: 'connected' | 'needs-auth'
  email?: string
  planType?: string
  codexHome?: string
}

export interface SubscriptionQuotaWindow {
  id: 'primary' | 'secondary'
  label: string
  usedPercent: number
  limitWindowSeconds: number
  resetsAt: number | null
  resetAfterSeconds: number
}

export interface SubscriptionUsageDetails {
  planType: string
  accountId: string
  userId: string | null
  windows: SubscriptionQuotaWindow[]
}

export interface UsageSnapshot {
  accountId: string
  source: UsageSource
  range: UsageRange
  models: ModelUsage[]
  updatedAt: number
  mode?: 'demo' | 'live'
  notice?: string
  cache?: { hit: boolean; expiresAt: number }
  localUsage?: { status: 'ready' | 'missing' | 'unconfigured' | 'error' | 'partial'; directory?: string; warning?: string; attribution: 'user-selected' }
  subscription?: SubscriptionUsageDetails
}

export interface UsageProvider {
  source: UsageSource
  listAccounts(): Promise<UsageAccount[]>
  getUsage(accountId: string, range: UsageRange): Promise<UsageSnapshot>
}

export interface ApiAccountInput {
  name: string
  apiKey: string
  organizationId: string
}

export interface DesktopBridge {
  platform: string
  isDesktop: boolean
  listAccounts(): Promise<UsageAccount[]>
  addApiAccount(input: ApiAccountInput): Promise<UsageAccount>
  removeAccount(accountId: string): Promise<boolean>
  chooseCodexHome(accountId: string): Promise<UsageAccount | null>
  startSubscriptionLogin(): Promise<UsageAccount>
  cancelSubscriptionLogin(): Promise<boolean>
  getUsage(input: { accountId: string; source: UsageSource; range: UsageRange; refreshToken?: number }): Promise<UsageSnapshot>
}
