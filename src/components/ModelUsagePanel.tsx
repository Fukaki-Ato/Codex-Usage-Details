import { useState } from 'react'
import { formatModelName, formatNumber, formatTokenValue } from '../chart-utils'
import { estimateModelCost } from '../pricing'
import { aggregateBuckets, mergeBuckets, sumBuckets } from '../usage-utils'
import { RequestsChart, TokenLegend, TokensChart } from './UsageCharts'
import type { ModelUsage, UsageRange, UsageSource } from '../types'

const rateNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 })

function costRateDescription(estimate: ReturnType<typeof estimateModelCost>) {
  if (!estimate) return '尚无此模型或缓存写入的已核实价格'
  const { pricing, appliedRates } = estimate
  const rates = [{ label: 'Standard', multiplier: 1 }, ...appliedRates]
  const lines = rates.map(({ label, multiplier }) => {
    const format = (value: number) => rateNumber.format(value * multiplier)
    const cacheWrite = pricing.cacheWrite === undefined ? '' : ` · 30 分钟写入 ${format(pricing.cacheWrite)}`
    const cacheWrite12h = pricing.cacheWrite12h === undefined ? '' : ` · 12 小时写入 ${format(pricing.cacheWrite12h)}`
    return `${label}  输入 ${format(pricing.input)} · 缓存输入 ${format(pricing.cachedInput)}${cacheWrite}${cacheWrite12h} · 输出 ${format(pricing.output)}`
  })
  return ['美元 / 百万 Token', ...lines].join('\n')
}

export function ModelUsagePanel({ models, range, source, selectedModel, onSelectModel }: { models: ModelUsage[]; range: UsageRange; source: UsageSource; selectedModel: string; onSelectModel: (model: string) => void }) {
  const [sort, setSort] = useState('tokens')
  const rows = models.map((model) => ({ model, totals: sumBuckets(model.buckets), estimate: estimateModelCost(model) }))
    .sort((a, b) => sort === 'name' ? a.model.model.localeCompare(b.model.model) : sort === 'cost' ? (b.estimate?.amount ?? -1) - (a.estimate?.amount ?? -1) : sort === 'requests' ? b.totals.requests - a.totals.requests : b.totals.tokens - a.totals.tokens)
  const active = rows.find((row) => row.model.model === selectedModel)
  const timeline = mergeBuckets(models.flatMap((model) => model.buckets)).map((bucket) => bucket.timestamp)
  const visibleRows = active ? [active] : rows
  const requestLabel = source === 'api' ? 'API 请求' : '用量记录'
  return <div className="model-browser">
    {visibleRows.map((row) => {
      const byTimestamp = new Map(mergeBuckets(row.model.buckets).map((bucket) => [bucket.timestamp, bucket]))
      const chart = aggregateBuckets(timeline.map((timestamp) => byTimestamp.get(timestamp) || { timestamp, requestCount: 0, cachedTokens: 0, uncachedTokens: 0, outputTokens: 0 }))
      const intervalLabel = chart.label === '原始时间分桶' ? range === 'today' ? '每小时' : '每日' : chart.label
      const modelName = formatModelName(row.model.model)
      return <section className="model-trends" key={row.model.model} aria-label={`${modelName} 用量趋势`}>
        <div className="model-heading"><h2><i aria-hidden="true" />{modelName}</h2><span>{intervalLabel}</span></div>
        <div className="charts-grid">
          <section className="chart-module" aria-label={`${modelName} Token 用量趋势`}>
            <h3>Token 用量</h3>
            <TokenLegend />
            <TokensChart key={`${range}-tokens`} buckets={chart.buckets} range={range} />
          </section>
          <section className="chart-module" aria-label={`${modelName} ${requestLabel}趋势`}>
            <h3>{source === 'api' ? 'API 请求次数' : '用量记录数'}</h3>
            <RequestsChart key={`${range}-requests`} buckets={chart.buckets} range={range} requestLabel={requestLabel} />
          </section>
        </div>
      </section>
    })}
    <details className="model-details"><summary>模型明细 <span>{models.length} 个模型</span></summary>
      <div className="model-toolbar"><label>排序 <select aria-label="模型排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="tokens">Token 用量</option><option value="requests">记录数</option><option value="cost">估算金额</option><option value="name">模型名称</option></select></label></div>
      <div className="model-table-scroll"><table className="model-table"><thead><tr><th>模型</th><th>{requestLabel}</th><th>Token</th><th>{source === 'api' ? '估算费用' : 'API 价格折算'}</th></tr></thead>
        <tbody>{rows.map((row) => <tr className={row === active ? 'selected' : ''} key={row.model.model}><td><button onClick={() => onSelectModel(row === active ? '' : row.model.model)} aria-pressed={row === active} title={row.model.model}>{formatModelName(row.model.model)}</button></td><td>{formatNumber(row.totals.requests)}</td><td title={formatNumber(row.totals.tokens)}>{formatTokenValue(row.totals.tokens)}</td><td title={costRateDescription(row.estimate)}>{row.estimate ? `$${row.estimate.amount.toFixed(2)}` : '未计价'}</td></tr>)}</tbody></table></div>
    </details>
  </div>
}
