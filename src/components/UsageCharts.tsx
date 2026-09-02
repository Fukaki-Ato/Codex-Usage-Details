import { useState } from 'react'
import {
  formatAxisValue,
  formatBucketLabel,
  formatNumber,
  formatTooltipLabel,
  requestScale,
  scaleTicks,
  tokenScale,
} from '../chart-utils'
import type { UsageBucket, UsageRange } from '../types'

const plot = { left: 42, right: 980, top: 18, bottom: 170 }
const dataPadding = 48

function xPosition(index: number, length: number) {
  const left = plot.left + dataPadding
  const right = plot.right - dataPadding
  if (length <= 1) return (left + right) / 2
  return left + (index / (length - 1)) * (right - left)
}

function sparseLabels(labels: string[]) {
  if (labels.length <= 7) return labels
  const interval = Math.max(1, Math.ceil((labels.length - 1) / 6))
  return labels.map((label, index) =>
    index === 0 || index === labels.length - 1 || index % interval === 0 ? label : '',
  )
}

function ChartGrid({ scale, labels }: { scale: ReturnType<typeof requestScale>; labels: string[] }) {
  const ticks = scaleTicks(scale)
  return (
    <>
      {ticks.map((tick) => {
        const y = plot.bottom - (tick / scale.max) * (plot.bottom - plot.top)
        return (
          <g key={tick}>
            <line className="chart-grid" x1={plot.left} x2={plot.right} y1={y} y2={y} />
            <text className="chart-axis-label" x={plot.left - 7} y={y + 4} textAnchor="end">
              {formatAxisValue(tick, scale)}
            </text>
          </g>
        )
      })}
      {labels.map((label, index) => (
        <text
          className="chart-axis-label chart-x-label"
          key={`${label}-${index}`}
          x={xPosition(index, labels.length)}
          y={plot.bottom + 25}
          textAnchor="middle"
        >
          {label}
        </text>
      ))}
    </>
  )
}

function svgPoint(event: React.MouseEvent<SVGElement>) {
  const svg = event.currentTarget.ownerSVGElement
  if (!svg) return { x: plot.left, y: plot.top }
  const bounds = svg.getBoundingClientRect()
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * 1000,
    y: ((event.clientY - bounds.top) / bounds.height) * 220,
  }
}

function useTooltip(length: number) {
  const [active, setActive] = useState<{ index: number; pointer: { x: number; y: number } } | null>(null)

  function move(event: React.MouseEvent<SVGElement>, fixedIndex?: number) {
    if (!length) return
    const pointer = svgPoint(event)
    if (fixedIndex !== undefined) {
      setActive({ index: fixedIndex, pointer })
      return
    }
    const position = pointer.x
    const dataLeft = xPosition(0, length)
    const dataRight = xPosition(length - 1, length)
    const index = Math.round(((position - dataLeft) / (dataRight - dataLeft)) * (length - 1))
    setActive({ index: Math.max(0, Math.min(length - 1, index)), pointer })
  }

  function enter(index: number, event: React.MouseEvent<SVGElement>) {
    setActive({ index, pointer: svgPoint(event) })
  }

  return {
    activeIndex: active?.index ?? null,
    pointer: active?.pointer ?? null,
    enter,
    move,
    leave: () => setActive(null),
  }
}

function floatingTooltipPosition(pointer: { x: number; y: number }, width: number, height: number) {
  const gap = 14
  let x = pointer.x + gap
  if (x + width > plot.right) x = pointer.x - width - gap
  let y = pointer.y - height - gap
  if (y < plot.top) y = pointer.y + gap
  return {
    x: Math.max(plot.left, Math.min(plot.right - width, x)),
    y: Math.max(5, Math.min(plot.bottom - height - 8, y)),
  }
}

function pointTooltipPosition(point: { x: number; y: number }, width: number, height: number) {
  return {
    x: Math.max(plot.left, Math.min(plot.right - width, point.x - width / 2)),
    y: Math.max(-32, point.y - height - 12),
  }
}

function smoothPath(points: Array<{ x: number; y: number }>) {
  if (!points.length) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  let path = `M ${points[0].x} ${points[0].y}`
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] || points[index]
    const current = points[index]
    const next = points[index + 1]
    const following = points[index + 2] || next
    const controlOne = {
      x: current.x + (next.x - previous.x) / 6,
      y: current.y + (next.y - previous.y) / 6,
    }
    const controlTwo = {
      x: next.x - (following.x - current.x) / 6,
      y: next.y - (following.y - current.y) / 6,
    }
    const minimumY = Math.min(current.y, next.y)
    const maximumY = Math.max(current.y, next.y)
    controlOne.y = Math.max(minimumY, Math.min(maximumY, controlOne.y))
    controlTwo.y = Math.max(minimumY, Math.min(maximumY, controlTwo.y))
    path += ` C ${controlOne.x} ${controlOne.y}, ${controlTwo.x} ${controlTwo.y}, ${next.x} ${next.y}`
  }
  return path
}

export function RequestsChart({ buckets, range }: { buckets: UsageBucket[]; range: UsageRange }) {
  const scale = requestScale(buckets.map((bucket) => bucket.requestCount))
  const labels = buckets.map((bucket) => formatBucketLabel(bucket.timestamp, range))
  const axisLabels = sparseLabels(labels)
  const tooltip = useTooltip(buckets.length)
  const points = buckets
    .map((bucket, index) => {
      const x = xPosition(index, buckets.length)
      const y = plot.bottom - (bucket.requestCount / scale.max) * (plot.bottom - plot.top)
      return { x, y }
    })
  const linePath = smoothPath(points)
  const areaPath = points.length ? `${linePath} L ${points[points.length - 1].x} ${plot.bottom} L ${points[0].x} ${plot.bottom} Z` : ''
  const activePoint = tooltip.activeIndex === null ? null : points[tooltip.activeIndex]
  const activeBucket = tooltip.activeIndex === null ? null : buckets[tooltip.activeIndex]
  const requestLabel = activeBucket ? `${formatNumber(activeBucket.requestCount)}次API请求` : ''
  const requestTooltipWidth = Math.max(92, requestLabel.length * 8 + 24)
  const requestTooltip = activePoint ? pointTooltipPosition(activePoint, requestTooltipWidth, 42) : null

  return (
    <div className="chart-shell request-chart-shell">
      <svg className="usage-chart" viewBox="0 0 1000 220" role="img" aria-label="API 请求次数曲线图">
        <ChartGrid scale={scale} labels={axisLabels} />
        <path className="request-area" d={areaPath} />
        <path className="request-line" d={linePath} />
        {points.map((point, index) => <circle className="request-data-point" key={index} cx={point.x} cy={point.y} r="2.5" />)}
        {points.map((point, index) => buckets[index].requestCount > 0 && <circle className="request-hit-area" key={`hit-${index}`} cx={point.x} cy={point.y} r="11" onMouseEnter={(event) => tooltip.enter(index, event)} onMouseMove={(event) => tooltip.move(event, index)} onMouseLeave={tooltip.leave} />)}
        {activePoint && activeBucket && activeBucket.requestCount > 0 && requestTooltip && <g className="request-tooltip-group" transform={`translate(${requestTooltip.x}, ${requestTooltip.y})`}>
          <rect className="request-tooltip-background" width={requestTooltipWidth} height="42" rx="7" />
          <text className="request-tooltip-date" x={requestTooltipWidth / 2} y="17" textAnchor="middle">{labels[tooltip.activeIndex!]}</text>
          <text className="request-tooltip-value" x={requestTooltipWidth / 2} y="35" textAnchor="middle">{requestLabel}</text>
        </g>}
      </svg>
    </div>
  )
}

export function TokensChart({ buckets, range }: { buckets: UsageBucket[]; range: UsageRange }) {
  const totals = buckets.map((bucket) => bucket.cachedTokens + bucket.uncachedTokens + (bucket.cacheWriteTokens || 0) + bucket.outputTokens + (bucket.reasoningTokens || 0))
  const scale = tokenScale(totals)
  const labels = buckets.map((bucket) => formatBucketLabel(bucket.timestamp, range))
  const axisLabels = sparseLabels(labels)
  const tooltip = useTooltip(buckets.length)
  const unit = scale.suffix === 'B' ? 1_000_000_000 : scale.suffix === 'M' ? 1_000_000 : 1_000
  const activeBucket = tooltip.activeIndex === null ? null : buckets[tooltip.activeIndex]
  const tokenRows = activeBucket ? [
    { label: '输入（命中缓存）', value: activeBucket.cachedTokens, className: 'cached-text', marker: 'cached' },
    { label: '输入（未命中缓存）', value: activeBucket.uncachedTokens, className: 'uncached-text', marker: 'uncached' },
    ...(activeBucket.cacheWriteTokens ? [{ label: '缓存写入', value: activeBucket.cacheWriteTokens, className: 'cache-write-text', marker: 'cache-write' }] : []),
    { label: '输出', value: activeBucket.outputTokens, className: 'output-text', marker: 'output' },
    ...(activeBucket.reasoningTokens ? [{ label: '推理', value: activeBucket.reasoningTokens, className: 'reasoning-text', marker: 'reasoning' }] : []),
  ] : []
  const tokenTooltipHeight = 51 + tokenRows.length * 22
  const tokenTooltipPosition = tooltip.pointer ? floatingTooltipPosition(tooltip.pointer, 330, tokenTooltipHeight) : null

  return (
    <div className="chart-shell token-chart-shell">
      <svg className="usage-chart" viewBox="0 0 1000 220" role="img" aria-label="Token 使用量柱状图">
        <ChartGrid scale={scale} labels={axisLabels} />
        {buckets.map((bucket, index) => {
          const bucketSpacing = buckets.length > 1 ? xPosition(1, buckets.length) - xPosition(0, buckets.length) : plot.right - plot.left
          const barWidth = Math.max(3, Math.min(36, bucketSpacing * 0.62))
          const x = xPosition(index, buckets.length) - barWidth / 2
          const total = bucket.cachedTokens + bucket.uncachedTokens + (bucket.cacheWriteTokens || 0) + bucket.outputTokens + (bucket.reasoningTokens || 0)
          const barTop = plot.bottom - (total / unit / scale.max) * (plot.bottom - plot.top)
          const segments = [
            { value: bucket.outputTokens, className: 'bar-output' },
            { value: bucket.reasoningTokens || 0, className: 'bar-reasoning' },
            { value: bucket.cacheWriteTokens || 0, className: 'bar-cache-write' },
            { value: bucket.uncachedTokens, className: 'bar-uncached' },
            { value: bucket.cachedTokens, className: 'bar-cached' },
          ].filter((segment) => segment.value > 0).sort((left, right) => right.value - left.value)
          let offset = plot.bottom
          return <g key={index}>
            {segments.map((segment) => {
              const height = (segment.value / unit / scale.max) * (plot.bottom - plot.top)
              offset -= height
              return <rect className={segment.className} key={`${index}-${segment.className}`} x={x} y={offset} width={barWidth} height={height} />
            })}
            <rect className="bar-hit-area" x={x - 8} y={Math.max(plot.top, barTop - 8)} width={barWidth + 16} height={Math.max(16, plot.bottom - Math.max(plot.top, barTop - 8) + 8)} onMouseEnter={(event) => tooltip.enter(index, event)} onMouseMove={(event) => tooltip.move(event, index)} onMouseLeave={tooltip.leave} />
          </g>
        })}
        {tooltip.activeIndex !== null && tooltip.pointer && tokenTooltipPosition && activeBucket && (
          <>
            <line
              className="chart-crosshair"
              x1={xPosition(tooltip.activeIndex, buckets.length)}
              x2={xPosition(tooltip.activeIndex, buckets.length)}
              y1={plot.top}
              y2={plot.bottom}
            />
            <g className="token-tooltip-group" transform={`translate(${tokenTooltipPosition.x}, ${tokenTooltipPosition.y})`}>
              <rect className="chart-tooltip token-tooltip" width="330" height={tokenTooltipHeight} rx="18" />
              <text className="tooltip-title" x="16" y="26">
                {formatTooltipLabel(activeBucket.timestamp, range)}
              </text>
              <text className="tooltip-total" x="314" y="26" textAnchor="end">
                {formatNumber(activeBucket.cachedTokens + activeBucket.uncachedTokens + (activeBucket.cacheWriteTokens || 0) + activeBucket.outputTokens + (activeBucket.reasoningTokens || 0))} <tspan className="tooltip-unit">Tokens</tspan>
              </text>
              {tokenRows.map((row, index) => {
                const y = 54 + index * 22
                const cacheInputTotal = activeBucket.cachedTokens + activeBucket.uncachedTokens
                const value = row.label === '输入（命中缓存）'
                  ? `${formatNumber(row.value)} · ${((row.value / Math.max(1, cacheInputTotal)) * 100).toFixed(1)}%`
                  : formatNumber(row.value)
                return <g key={row.label}><rect className={`tooltip-row-marker ${row.marker}`} x="16" y={y - 11} width="12" height="12" rx="3" /><text className={`tooltip-row-label ${row.className}`} x="38" y={y}>{row.label}</text><text className="tooltip-row-value" x="314" y={y} textAnchor="end">{value}</text></g>
              })}
            </g>
          </>
        )}
      </svg>
    </div>
  )
}
