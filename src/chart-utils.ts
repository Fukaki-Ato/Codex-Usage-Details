export interface AxisScale {
  max: number
  step: number
  suffix: string
}

function niceStep(value: number) {
  if (value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const power = 10 ** exponent
  const fraction = value / power
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return niceFraction * power
}

export function requestScale(values: number[]): AxisScale {
  const highest = Math.max(...values, 0)
  const step = Math.max(5, Math.ceil((highest / 4) / 5) * 5)
  return { step, max: Math.max(5, Math.ceil(highest / step) * step), suffix: '' }
}

export function tokenScale(values: number[]): AxisScale {
  const highest = Math.max(...values, 0)
  const base = highest >= 1_000_000_000 ? 1_000_000_000 : highest >= 1_000_000 ? 1_000_000 : 1_000
  const suffix = base === 1_000_000_000 ? 'B' : base === 1_000_000 ? 'M' : 'K'
  const scaledHighest = highest / base
  const step = niceStep(scaledHighest / 4)
  return {
    step,
    max: Math.max(step, Math.ceil(scaledHighest / step) * step),
    suffix,
  }
}

export function scaleTicks(scale: AxisScale) {
  const ticks: number[] = []
  for (let value = 0; value <= scale.max + scale.step / 100; value += scale.step) {
    ticks.push(Number(value.toFixed(6)))
  }
  return ticks.reverse()
}

export function formatAxisValue(value: number, scale: AxisScale) {
  if (!scale.suffix) return String(Math.round(value))
  return `${Number(value.toFixed(2))}${scale.suffix}`
}

export function formatTokenValue(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`
  return String(value)
}

export function formatBucketLabel(timestamp: number, range: 'today' | '7d' | '30d' | 'all') {
  const date = new Date(timestamp)
  if (range === 'today') return `${String(date.getHours()).padStart(2, '0')}:00`
  return `${date.getMonth() + 1}/${date.getDate()}`
}

export function formatTooltipLabel(timestamp: number, range: 'today' | '7d' | '30d' | 'all') {
  const date = new Date(timestamp)
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  if (range === 'today') return `${day} ${String(date.getHours()).padStart(2, '0')}:00`
  return day
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

export function formatModelName(model: string) {
  return model.split('-').map((part, index) => {
    if (index === 0 && part.toLowerCase() === 'gpt') return 'GPT'
    if (/^[a-z]+$/i.test(part)) return `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`
    return part
  }).join('-')
}
