import { useState } from 'react'
import { formatNumber, formatTokenValue } from '../chart-utils'
import { estimateModelCost } from '../pricing'
import { aggregateBuckets, sumBuckets } from '../usage-utils'
import { RequestsChart, TokensChart } from './UsageCharts'
import type { ModelUsage, UsageRange, UsageSource } from '../types'

export function ModelUsagePanel({ models, range, source }: { models: ModelUsage[]; range: UsageRange; source: UsageSource }) {
  const [sort, setSort] = useState('tokens')
  const [selected, setSelected] = useState('')
  const rows = models.map((model) => ({ model, totals: sumBuckets(model.buckets), cost: estimateModelCost(model)?.amount }))
    .sort((a, b) => sort === 'name' ? a.model.model.localeCompare(b.model.model) : sort === 'cost' ? (b.cost ?? -1) - (a.cost ?? -1) : sort === 'requests' ? b.totals.requests - a.totals.requests : b.totals.tokens - a.totals.tokens)
  const active = rows.find((row) => row.model.model === selected) || rows[0]
  const chart = aggregateBuckets(active.model.buckets)
  const requestLabel = source === 'api' ? 'API 请求' : '用量记录'
  return <div className="model-browser">
    <div className="model-toolbar"><span>{models.length} 个模型 · 选择模型查看趋势</span><label>排序 <select aria-label="模型排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="tokens">Token 用量</option><option value="requests">记录数</option><option value="cost">估算金额</option><option value="name">模型名称</option></select></label></div>
    <div className="model-table-scroll"><table className="model-table"><thead><tr><th>模型</th><th>{requestLabel}</th><th>Token</th><th>{source === 'api' ? '估算费用' : 'API 价格折算'}</th></tr></thead>
      <tbody>{rows.map((row) => <tr className={row === active ? 'selected' : ''} key={row.model.model}><td><button onClick={() => setSelected(row.model.model)} aria-pressed={row === active}>{row.model.model}</button></td><td>{formatNumber(row.totals.requests)}</td><td title={formatNumber(row.totals.tokens)}>{formatTokenValue(row.totals.tokens)}</td><td>{row.cost === undefined ? '未计价' : `$${row.cost.toFixed(2)}`}</td></tr>)}</tbody></table></div>
    <article className="model-card"><div className="model-card-head"><h3>{active.model.model}</h3><span>{chart.label}</span></div>
      <div className="charts-grid"><div className="chart-module"><div className="chart-module-head"><span>{requestLabel} <b>{formatNumber(active.totals.requests)}</b></span></div><RequestsChart key={`${active.model.model}-${range}`} buckets={chart.buckets} range={range} requestLabel={requestLabel} /></div>
        <div className="chart-module"><div className="chart-module-head"><span>Token 构成 <b title={formatNumber(active.totals.tokens)}>{formatTokenValue(active.totals.tokens)}</b></span></div><TokensChart key={`${active.model.model}-${range}`} buckets={chart.buckets} range={range} /></div></div>
      <div className="chart-legend" aria-label="图例"><span><i className="cached" />缓存命中输入</span><span><i className="uncached" />未缓存输入</span><span><i className="cache-write" />缓存写入</span><span><i className="output" />可见输出</span><span><i className="reasoning" />推理输出</span></div>
    </article>
  </div>
}
