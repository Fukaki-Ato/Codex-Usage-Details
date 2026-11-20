import type { ModelUsage, UsageTokenCounts } from './types'

export interface ApiModelPricing {
  input: number
  cachedInput: number
  cacheWrite?: number
  cacheWrite12h?: number
  output: number
}

// Standard text prices in USD per 1M tokens. GPT-6 uses short-context rates (<=272K input).
export const officialPricingSource = 'https://developers.openai.com/api/docs/pricing/'
export const officialPricingVerifiedOn = '2026-11-18'

const gpt62Prices = {
  'gpt-6.2-astra': { input: 8, cachedInput: 0.4, cacheWrite: 10, cacheWrite12h: 20, output: 40 },
  'gpt-6.2-sol': { input: 2, cachedInput: 0.1, cacheWrite: 2.5, cacheWrite12h: 5, output: 10 },
}

const acceleratedRates = [
  { key: 'fast', label: 'Fast', multiplier: 2 },
  { key: 'ultrafastPromotional', label: 'Ultrafast（优惠）', multiplier: 3 },
  { key: 'ultrafastList', label: 'Ultrafast（原价）', multiplier: 6 },
] as const

const pricingTable: Record<string, ApiModelPricing> = {
  ...gpt62Prices,
  'gpt-6-astra': { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
  'gpt-6.1-sol': { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
  'gpt-6.1-terra': { input: 1, cachedInput: 0.05, cacheWrite: 1.25, output: 5 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  'gpt-6-sol': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
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
  // Historical Codex rates: https://developers.openai.com/api/docs/models/gpt-5.2-codex.md
  'gpt-5.2-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.2-pro': { input: 21, cachedInput: 0, output: 168 },
  // https://developers.openai.com/api/docs/models/gpt-5.1-codex.md
  'gpt-5.1-codex': { input: 1.25, cachedInput: 0.125, output: 10 },
  // This page also lists GPT-5 Codex in its comparison: https://developers.openai.com/api/docs/models/gpt-5.1-codex-max.md
  'gpt-5.1-codex-max': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-codex': { input: 1.25, cachedInput: 0.125, output: 10 },
  // https://developers.openai.com/api/docs/models/gpt-5.1-codex-mini.md
  'gpt-5.1-codex-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
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

function pricingModelId(model: string) {
  if (Object.hasOwn(pricingTable, model)) return model
  const snapshot = model.match(/^(.+)-\d{4}-\d{2}-\d{2}$/)
  return snapshot && Object.hasOwn(pricingTable, snapshot[1]) ? snapshot[1] : null
}

export function pricingForModel(model: string) {
  const id = pricingModelId(model)
  return id ? pricingTable[id] : null
}

function tokenCost(tokens: UsageTokenCounts, pricing: ApiModelPricing) {
  const shortWritePrice = pricing.cacheWrite ?? 0
  const extraFor12h = (pricing.cacheWrite12h ?? shortWritePrice) - shortWritePrice
  return tokens.uncachedTokens * pricing.input + tokens.cachedTokens * pricing.cachedInput
    + (tokens.cacheWriteTokens || 0) * shortWritePrice + (tokens.cacheWrite12hTokens || 0) * extraFor12h
    + tokens.outputTokens * pricing.output
}

export function estimateModelCost(model: ModelUsage) {
  const id = pricingModelId(model.model)
  if (!id) return null
  const pricing = pricingTable[id]
  const totals = model.buckets.reduce((sum, bucket) => ({
    cachedTokens: sum.cachedTokens + bucket.cachedTokens,
    uncachedTokens: sum.uncachedTokens + bucket.uncachedTokens,
    cacheWriteTokens: sum.cacheWriteTokens + (bucket.cacheWriteTokens || 0),
    cacheWrite12hTokens: sum.cacheWrite12hTokens + (bucket.cacheWrite12hTokens || 0),
    outputTokens: sum.outputTokens + bucket.outputTokens,
  }), { cachedTokens: 0, uncachedTokens: 0, cacheWriteTokens: 0, cacheWrite12hTokens: 0, outputTokens: 0 })
  if (totals.cacheWriteTokens > 0 && pricing.cacheWrite === undefined) return null

  let cost = tokenCost(totals, pricing)
  const appliedRates: { label: string; multiplier: number }[] = []
  if (Object.hasOwn(gpt62Prices, id)) {
    for (const { key, label, multiplier } of acceleratedRates) {
      let standardCost = 0
      for (const bucket of model.buckets) {
        const tokens = bucket.acceleratedUsage?.[key]
        if (tokens) standardCost += tokenCost(tokens, pricing)
      }
      if (!standardCost) continue
      // The accelerated tokens are already in the totals at Standard rates.
      cost += standardCost * (multiplier - 1)
      appliedRates.push({ label, multiplier })
    }
  }
  return {
    pricing,
    amount: cost / 1_000_000,
    appliedRates,
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
