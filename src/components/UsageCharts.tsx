import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { formatAxisValue, formatBucketLabel, formatNumber, formatTooltipLabel, requestScale, scaleTicks, tokenScale } from '../chart-utils'
import type { UsageBucket, UsageRange } from '../types'
import { totalTokens } from '../usage-utils'

type Plot = { left: number; right: number; top: number; bottom: number; width: number; height: number }

function usePlot() {
  const shellRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1000)
  useLayoutEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    const measure = () => { if (shell.clientWidth > 0) setWidth(shell.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])
  const plot: Plot = { left: width < 480 ? 42 : 50, right: width - 12, top: 16, bottom: 228, width, height: 260 }
  return { shellRef, plot }
}

const series = [
  { key: 'uncached', label: '未缓存输入' },
  { key: 'output', label: '输出' },
  { key: 'reasoning', label: '推理' },
  { key: 'cached', label: '缓存读取' },
  { key: 'cache-write', label: '缓存写入' },
] as const

function parts(bucket: UsageBucket) {
  const reasoning = Math.max(0, Math.min(bucket.outputTokens, bucket.reasoningTokens || 0))
  return [bucket.uncachedTokens, Math.max(0, bucket.outputTokens - reasoning), reasoning, bucket.cachedTokens, bucket.cacheWriteTokens || 0]
}

function xPosition(plot: Plot, index: number, length: number) {
  return plot.left + (index + 0.5) * (plot.right - plot.left) / Math.max(1, length)
}

function ChartGrid({ plot, scale, buckets, range }: { plot: Plot; scale: ReturnType<typeof requestScale>; buckets: UsageBucket[]; range: UsageRange }) {
  const maxLabels = Math.max(2, Math.floor((plot.right - plot.left) / (range === 'today' ? 65 : 90)))
  const labelStep = Math.max(1, Math.ceil(buckets.length / maxLabels))
  return <>
    {scaleTicks(scale).map((tick) => {
      const y = plot.bottom - tick / scale.max * (plot.bottom - plot.top)
      return <g key={tick}><line className="chart-grid" x1={plot.left} x2={plot.right} y1={y} y2={y} /><text className="chart-axis-label" x={plot.left - 12} y={y + 4} textAnchor="end">{formatAxisValue(tick, scale)}</text></g>
    })}
    {buckets.map((bucket, index) => (buckets.length - 1 - index) % labelStep === 0
      ? <text className="chart-axis-label chart-x-label" key={bucket.timestamp} x={xPosition(plot, index, buckets.length)} y={249} textAnchor="middle">{formatBucketLabel(bucket.timestamp, range)}</text> : null)}
  </>
}

type TooltipTarget = { index: number; clientX?: number; clientY?: number }

function useTooltip(length: number, plot: Plot, shellRef: RefObject<HTMLDivElement | null>) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const targetRef = useRef<TooltipTarget | null>(null)
  const frameRef = useRef(0)

  function position() {
    const target = targetRef.current
    const shell = shellRef.current
    const tooltip = tooltipRef.current
    if (!target || !shell || !tooltip) return
    const bounds = shell.getBoundingClientRect()
    const width = tooltip.offsetWidth
    const height = tooltip.offsetHeight
    const px = target.clientX === undefined ? xPosition(plot, target.index, length) / plot.width * bounds.width : target.clientX - bounds.left
    const py = target.clientY === undefined ? 48 : target.clientY - bounds.top
    const left = Math.max(8, Math.min(px - width / 2, bounds.width - width - 8))
    const top = Math.max(-12, Math.min(py - height - 30, bounds.height - height - 8))
    tooltip.style.transform = `translate3d(${left}px, ${top}px, 0)`
  }

  function show(index: number, event?: React.PointerEvent<SVGGElement>) {
    if (!length) return
    targetRef.current = { index, clientX: event?.clientX, clientY: event?.clientY }
    const draw = () => {
      frameRef.current = 0
      if (!targetRef.current) return
      setActiveIndex(targetRef.current.index)
      position()
    }
    if (event && typeof requestAnimationFrame === 'function') {
      if (!frameRef.current) frameRef.current = requestAnimationFrame(draw)
    } else draw()
  }

  function hide() {
    if (frameRef.current) cancelAnimationFrame(frameRef.current)
    frameRef.current = 0
    targetRef.current = null
    setActiveIndex(null)
  }

  useLayoutEffect(position)
  const visible = activeIndex !== null
  useLayoutEffect(() => {
    if (!visible || !tooltipRef.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(position)
    observer.observe(tooltipRef.current)
    if (shellRef.current) observer.observe(shellRef.current)
    return () => observer.disconnect()
  }, [visible, length])
  useEffect(() => () => { if (frameRef.current) cancelAnimationFrame(frameRef.current) }, [])

  function keyboard(event: React.KeyboardEvent<SVGSVGElement>) {
    if (event.key === 'Escape') { hide(); return }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !length) return
    event.preventDefault()
    const current = targetRef.current?.index ?? 0
    show(event.key === 'Home' ? 0 : event.key === 'End' ? length - 1 : Math.max(0, Math.min(length - 1, current + (event.key === 'ArrowLeft' ? -1 : 1))))
  }
  return { activeIndex, shellRef, tooltipRef, show, hide, keyboard, focus: () => { if (!targetRef.current) show(0) } }
}

function intervalLabel(bucket: UsageBucket, range: UsageRange) {
  const start = formatTooltipLabel(bucket.timestamp, range)
  return bucket.endTimestamp ? `${start} 至 ${formatTooltipLabel(bucket.endTimestamp, range)}` : start
}

function Crosshair({ plot, index, length }: { plot: Plot; index: number | null; length: number }) {
  return index === null ? null : <line className="chart-crosshair" x1={xPosition(plot, index, length)} x2={xPosition(plot, index, length)} y1={plot.top} y2={plot.bottom} />
}

export function TokenLegend() {
  return <div className="chart-legend" aria-label="图例">{series.map((item) => <span key={item.key}><i className={item.key} />{item.key === 'uncached' ? '输入' : item.label}</span>)}</div>
}

export function RequestsChart({ buckets, range, requestLabel = 'API 请求' }: { buckets: UsageBucket[]; range: UsageRange; requestLabel?: string }) {
  const scale = requestScale(buckets.map((bucket) => bucket.requestCount))
  const { shellRef, plot } = usePlot()
  const tooltip = useTooltip(buckets.length, plot, shellRef)
  const y = (value: number) => plot.bottom - value / scale.max * (plot.bottom - plot.top)
  const points = buckets.map((bucket, index) => `${xPosition(plot, index, buckets.length)},${y(bucket.requestCount)}`).join(' ')
  const activeBucket = tooltip.activeIndex === null ? null : buckets[tooltip.activeIndex]
  return <div className="chart-shell request-chart-shell" ref={tooltip.shellRef} onPointerLeave={tooltip.hide}>
    <svg className="usage-chart" viewBox={`0 0 ${plot.width} ${plot.height}`} height={plot.height} role="img" tabIndex={0} aria-label={`${requestLabel}次数折线图，左右方向键查看明细`} onFocus={tooltip.focus} onKeyDown={tooltip.keyboard} onBlur={tooltip.hide}>
      <ChartGrid plot={plot} scale={scale} buckets={buckets} range={range} />
      {buckets.length > 0 && <><polygon className="request-area" points={`${xPosition(plot, 0, buckets.length)},${plot.bottom} ${points} ${xPosition(plot, buckets.length - 1, buckets.length)},${plot.bottom}`} /><polyline className="request-line" points={points} /></>}
      {buckets.map((bucket, index) => <g key={bucket.timestamp} data-chart-index={index} onPointerEnter={(event) => tooltip.show(index, event)} onPointerMove={(event) => tooltip.show(index, event)}>
        <circle className="request-data-point" cx={xPosition(plot, index, buckets.length)} cy={y(bucket.requestCount)} r={2.3} />
        <rect className="chart-hit-area" x={plot.left + index * (plot.right - plot.left) / buckets.length} y={plot.top} width={(plot.right - plot.left) / buckets.length} height={plot.bottom - plot.top} />
      </g>)}
      <Crosshair plot={plot} index={tooltip.activeIndex} length={buckets.length} />
    </svg>
    {activeBucket && <div className="chart-tooltip request-tooltip" ref={tooltip.tooltipRef} role="tooltip">
      <div className="chart-tooltip-date">{intervalLabel(activeBucket, range)}</div>
      <div className="chart-tooltip-headline"><strong>{formatNumber(activeBucket.requestCount)}</strong><span>{requestLabel === '用量记录' ? '条用量记录' : '次请求'}</span></div>
    </div>}
  </div>
}

export function TokensChart({ buckets, range }: { buckets: UsageBucket[]; range: UsageRange }) {
  const scale = tokenScale(buckets.map(totalTokens))
  const unit = scale.suffix === 'B' ? 1_000_000_000 : scale.suffix === 'M' ? 1_000_000 : 1_000
  const { shellRef, plot } = usePlot()
  const tooltip = useTooltip(buckets.length, plot, shellRef)
  const activeBucket = tooltip.activeIndex === null ? null : buckets[tooltip.activeIndex]
  const activeParts = activeBucket ? parts(activeBucket) : []
  const input = activeBucket ? activeBucket.cachedTokens + activeBucket.uncachedTokens + (activeBucket.cacheWriteTokens || 0) : 0
  return <div className="chart-shell token-chart-shell" ref={tooltip.shellRef} onPointerLeave={tooltip.hide}>
    <svg className="usage-chart" viewBox={`0 0 ${plot.width} ${plot.height}`} height={plot.height} role="img" tabIndex={0} aria-label="Token 使用量柱状图，左右方向键查看明细" onFocus={tooltip.focus} onKeyDown={tooltip.keyboard} onBlur={tooltip.hide}>
      <ChartGrid plot={plot} scale={scale} buckets={buckets} range={range} />
      {buckets.map((bucket, index) => {
        const slotWidth = (plot.right - plot.left) / Math.max(1, buckets.length)
        const width = Math.min(18, slotWidth * 0.4)
        let baseline = plot.bottom
        return <g key={bucket.timestamp} data-chart-index={index} onPointerEnter={(event) => tooltip.show(index, event)} onPointerMove={(event) => tooltip.show(index, event)}>
          {parts(bucket).map((value, part) => {
            const height = value / unit / scale.max * (plot.bottom - plot.top)
            baseline -= height
            return <rect className={`bar-${series[part].key}`} key={series[part].key} x={xPosition(plot, index, buckets.length) - width / 2} y={baseline} width={width} height={height} />
          })}
          <rect className="chart-hit-area" x={plot.left + index * slotWidth} y={plot.top} width={slotWidth} height={plot.bottom - plot.top} />
        </g>
      })}
      <Crosshair plot={plot} index={tooltip.activeIndex} length={buckets.length} />
    </svg>
    {activeBucket && <div className="chart-tooltip token-tooltip" ref={tooltip.tooltipRef} role="tooltip">
      <div className="chart-tooltip-date">{intervalLabel(activeBucket, range)}</div>
      <div className="chart-tooltip-headline"><strong>{formatNumber(totalTokens(activeBucket))}</strong><span>Tokens</span></div>
      {[3, 0, 4, 1, 2].map((part) => <div className="chart-tooltip-row" key={series[part].key}><span><i className={series[part].key} />{part === 3 ? '缓存命中' : series[part].label}</span><b>{formatNumber(activeParts[part])}{part === 3 ? ` · ${input ? (activeBucket.cachedTokens / input * 100).toFixed(2) + '%' : '--'}` : ''}</b></div>)}
    </div>}
  </div>
}
