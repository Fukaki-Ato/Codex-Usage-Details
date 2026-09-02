export type UsageSource = 'api' | 'subscription'
export type UsageRange = 'today' | '7d' | '30d' | 'all'

export interface UsageBucket {
  timestamp: number
  requestCount: number
  cachedTokens: number
  uncachedTokens: number
  cacheWriteTokens?: number
  outputTokens: number
  reasoningTokens?: number
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
