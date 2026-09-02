import type { ModelUsage } from './types'

export interface ApiModelPricing {
  input: number
  cachedInput: number
  cacheWrite?: number
  output: number
}

// Standard text prices in USD per 1M tokens, verified against OpenAI's pricing page.
export const officialPricingSource = 'https://developers.openai.com/api/docs/pricing/'
export const officialPricingVerifiedOn = '2026-09-01'

const pricingTable: Record<string, ApiModelPricing> = {
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.5-pro': { input: 30, cachedInput: 0, output: 180 },
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
  'gpt-5.4-pro': { input: 30, cachedInput: 0, output: 180 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.2-pro': { input: 21, cachedInput: 0, output: 168 },
  'gpt-5.1': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
  'gpt-5-pro': { input: 15, cachedInput: 0, output: 120 },
  'gpt-4.1': { input: 2, cachedInput: 0.5, output: 8 },
  'gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cachedInput: 0.025, output: 0.4 },
  'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10 },
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
  o1: { input: 15, cachedInput: 7.5, output: 60 },
  'o1-pro': { input: 150, cachedInput: 0, output: 600 },
  o3: { input: 2, cachedInput: 0.5, output: 8 },
  'o3-pro': { input: 20, cachedInput: 0, output: 80 },
  'o4-mini': { input: 1.1, cachedInput: 0.275, output: 4.4 },
  'o3-mini': { input: 1.1, cachedInput: 0.55, output: 4.4 },
  'gpt-4-turbo-2024-04-09': { input: 10, cachedInput: 0, output: 30 },
  'gpt-3.5-turbo': { input: 0.5, cachedInput: 0, output: 1.5 },
  'gpt-3.5-turbo-0125': { input: 0.5, cachedInput: 0, output: 1.5 },
}

const pricingAliases: Array<[RegExp, string]> = [
  [/^gpt-5\.6-sol(?:-|$)/, 'gpt-5.6-sol'],
  [/^gpt-5\.6-terra(?:-|$)/, 'gpt-5.6-terra'],
  [/^gpt-5\.6-luna(?:-|$)/, 'gpt-5.6-luna'],
  [/^gpt-5\.5-pro(?:-|$)/, 'gpt-5.5-pro'],
  [/^gpt-5\.5(?:-|$)/, 'gpt-5.5'],
  [/^gpt-5\.4-pro(?:-|$)/, 'gpt-5.4-pro'],
  [/^gpt-5\.4-mini(?:-|$)/, 'gpt-5.4-mini'],
  [/^gpt-5\.4(?:-|$)/, 'gpt-5.4'],
  [/^gpt-5\.3-codex(?:-|$)/, 'gpt-5.3-codex'],
  [/^gpt-5\.2-pro(?:-|$)/, 'gpt-5.2-pro'],
  [/^gpt-5\.2(?:-|$)/, 'gpt-5.2'],
  [/^gpt-5\.1(?:-|$)/, 'gpt-5.1'],
  [/^gpt-5-mini(?:-|$)/, 'gpt-5-mini'],
  [/^gpt-5-nano(?:-|$)/, 'gpt-5-nano'],
  [/^gpt-5-pro(?:-|$)/, 'gpt-5-pro'],
  [/^gpt-5(?:-|$)/, 'gpt-5'],
  [/^gpt-4\.1-mini(?:-|$)/, 'gpt-4.1-mini'],
  [/^gpt-4\.1-nano(?:-|$)/, 'gpt-4.1-nano'],
  [/^gpt-4\.1(?:-|$)/, 'gpt-4.1'],
  [/^gpt-4o-mini(?:-|$)/, 'gpt-4o-mini'],
  [/^gpt-4o(?:-|$)/, 'gpt-4o'],
  [/^o4-mini(?:-|$)/, 'o4-mini'],
  [/^o3-mini(?:-|$)/, 'o3-mini'],
  [/^o3-pro(?:-|$)/, 'o3-pro'],
  [/^o3(?:-|$)/, 'o3'],
  [/^o1-pro(?:-|$)/, 'o1-pro'],
  [/^o1(?:-|$)/, 'o1'],
]

export function pricingForModel(model: string) {
  if (pricingTable[model]) return pricingTable[model]
  const alias = pricingAliases.find(([pattern]) => pattern.test(model))
  return alias ? pricingTable[alias[1]] : null
}

export function estimateModelCost(model: ModelUsage) {
  const pricing = pricingForModel(model.model)
  if (!pricing) return null
  const totals = model.buckets.reduce((sum, bucket) => ({
    cached: sum.cached + bucket.cachedTokens,
    uncached: sum.uncached + bucket.uncachedTokens,
    cacheWrite: sum.cacheWrite + (bucket.cacheWriteTokens || 0),
    reasoning: sum.reasoning + (bucket.reasoningTokens || 0),
    output: sum.output + bucket.outputTokens,
  }), { cached: 0, uncached: 0, cacheWrite: 0, reasoning: 0, output: 0 })
  if (totals.cacheWrite > 0 && pricing.cacheWrite === undefined) return null
  return {
    pricing,
    amount: (totals.uncached * pricing.input + totals.cached * pricing.cachedInput + totals.cacheWrite * (pricing.cacheWrite || 0) + (totals.output + totals.reasoning) * pricing.output) / 1_000_000,
  }
}

export function estimateSnapshotCost(models: ModelUsage[]) {
  const estimates = models.map((model) => ({ model: model.model, estimate: estimateModelCost(model) }))
  const known = estimates.filter((item) => item.estimate)
  return {
    amount: known.reduce((sum, item) => sum + (item.estimate?.amount || 0), 0),
    unknownModels: estimates.filter((item) => !item.estimate).map((item) => item.model),
    byModel: estimates,
  }
}
