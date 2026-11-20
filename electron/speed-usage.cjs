// The promotional price ends at midnight Pacific time on March 1, 2027.
const ULTRAFAST_LIST_RATE_START = Date.parse('2027-03-01T00:00:00-08:00')
const tokenFields = ['cachedTokens', 'uncachedTokens', 'cacheWriteTokens', 'outputTokens']

function addTokensAtRate(target, rate, tokens) {
  const usage = target.acceleratedUsage ??= {}
  const totals = usage[rate] ??= { cachedTokens: 0, uncachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
  for (const field of tokenFields) totals[field] += tokens[field] ?? 0
  if (tokens.cacheWrite12hTokens) totals.cacheWrite12hTokens = (totals.cacheWrite12hTokens ?? 0) + tokens.cacheWrite12hTokens
}

function addAcceleratedUsage(target, serviceTier, timestamp, tokens) {
  const tier = typeof serviceTier === 'string' ? serviceTier.trim().toLowerCase() : ''
  if (tier === 'fast' || tier === 'priority') addTokensAtRate(target, 'fast', tokens)
  if (tier === 'ultrafast') {
    const rate = timestamp < ULTRAFAST_LIST_RATE_START ? 'ultrafastPromotional' : 'ultrafastList'
    addTokensAtRate(target, rate, tokens)
  }
}

function mergeAcceleratedUsage(target, source) {
  for (const [rate, tokens] of Object.entries(source ?? {})) addTokensAtRate(target, rate, tokens)
}

module.exports = { ULTRAFAST_LIST_RATE_START, addAcceleratedUsage, mergeAcceleratedUsage }
