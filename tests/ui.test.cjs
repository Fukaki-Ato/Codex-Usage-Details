require('./ts-loader.cjs')
const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const name of ['window', 'document', 'HTMLElement', 'SVGElement', 'SVGSVGElement', 'Node', 'MutationObserver']) globalThis[name] = name === 'window' ? dom.window : name === 'document' ? dom.window.document : dom.window[name]
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
const React = require('react')
const { render, screen, fireEvent, waitFor, cleanup, within } = require('@testing-library/react')
afterEach(cleanup)
const account = { id: 'one', name: 'Synthetic Pro', detail: 'test', sources: ['subscription'], status: 'connected' }
const bucket = { timestamp: Date.now(), requestCount: 1, cachedTokens: 40, uncachedTokens: 60, outputTokens: 20, reasoningTokens: 5 }
function mount(accounts, getUsage) {
  window.desktopBridge = { listAccounts: async () => accounts, getUsage }
  const file = require.resolve('../src/App.tsx')
  delete require.cache[file]
  return render(React.createElement(require(file).default))
}
test('unconnected and failed states never claim to be connected', async () => {
  mount([], async () => null)
  await waitFor(() => assert.ok(screen.getAllByText('未连接').length))
  assert.equal(screen.queryByText('已连接'), null)
  cleanup()
  mount([account], async () => { throw new Error('账户授权失效') })
  await screen.findByRole('alert')
  assert.ok(screen.getAllByText('授权失效').length)
  assert.equal(screen.queryByText('已连接'), null)
})
test('partial estimates, cached timestamp and log errors remain visible', async () => {
  const updatedAt = new Date('2026-01-02T03:04:05').getTime()
  mount([account], async (input) => ({ ...input, updatedAt, cache: { hit: true }, mode: 'live', models: [{ model: 'gpt-5', buckets: [bucket] }, { model: 'gpt-future', buckets: [bucket] }], localUsage: { status: 'error', warning: '模拟日志读取失败' }, subscription: { planType: 'Pro', windows: [{ id: 'secondary', label: '周额度', usedPercent: 28, limitWindowSeconds: 604800, resetsAt: null, resetAfterSeconds: 0 }] } }))
  await screen.findByText('已计价模型小计')
  assert.ok(screen.getByText(/以下模型未计入金额/))
  assert.ok(screen.getByText('模拟日志读取失败'))
  assert.ok(screen.getByText(/^读取于 2026.*缓存/))
  assert.equal(screen.queryByText('5 小时额度'), null)
  assert.ok(screen.getByText('周额度'))
  assert.ok(screen.getByRole('button', { name: '管理账户', exact: true }))
})

test('unconfigured local logs never appear as zero usage after a successful quota fetch', async () => {
  mount([account], async (input) => ({ ...input, updatedAt: Date.now(), mode: 'live', models: [], localUsage: { status: 'unconfigured', warning: '请选择日志目录' }, subscription: { planType: 'Pro', windows: [{ id: 'secondary', label: '周额度', usedPercent: 13, limitWindowSeconds: 604800, resetsAt: null, resetAfterSeconds: 0 }] } }))
  await screen.findByText('先配置此账户的日志目录')
  const summary = screen.getByRole('region', { name: '用量摘要' })
  assert.equal(summary.textContent.includes('0.0%'), false)
  assert.deepEqual([...summary.querySelectorAll('strong')].map((item) => item.textContent), ['--', '--', '--', '--'])
  assert.ok(screen.getByText('已连接'))
  assert.ok(screen.getByText('周额度'))
})

test('model filtering updates summary and charts together; all models share time buckets', async () => {
  const result = mount([account], async (input) => ({ ...input, updatedAt: Date.now(), mode: 'live', localUsage: { status: 'ready' }, models: [{ model: 'gpt-5', buckets: [bucket] }, { model: 'gpt-future', buckets: [{ ...bucket, timestamp: bucket.timestamp + 86400000, requestCount: 3, cachedTokens: 80, uncachedTokens: 120, outputTokens: 40 }] }] }))
  fireEvent.click(screen.getByRole('button', { name: '账户与筛选' }))
  const filter = await screen.findByRole('combobox', { name: '筛选模型' })
  await waitFor(() => assert.equal(filter.disabled, false))
  const values = () => [...screen.getByRole('region', { name: '用量摘要' }).querySelectorAll('strong')].map((item) => item.textContent)
  assert.deepEqual(values().slice(0, 3), ['360', '4', '40.00%'])
  assert.equal(result.container.querySelectorAll('.bar-cached').length, 4)
  assert.equal(screen.getAllByRole('img', { name: /用量记录.*折线图/ }).length, 2)
  assert.equal(screen.getAllByRole('img', { name: /Token 使用量/ }).length, 2)
  const modelCharts = [...result.container.querySelectorAll('.model-trends')]
  assert.deepEqual(modelCharts.map((model) => [...model.querySelectorAll('.token-chart-shell .chart-x-label')].map((label) => label.textContent)), Array(2).fill([...modelCharts[0].querySelectorAll('.token-chart-shell .chart-x-label')].map((label) => label.textContent)))
  const gpt5 = screen.getByRole('region', { name: 'GPT-5 用量趋势', exact: true })
  fireEvent.focus(within(gpt5).getByRole('img', { name: /Token 使用量/ }))
  assert.ok(within(screen.getByRole('tooltip')).getByText('120'))
  fireEvent.blur(within(gpt5).getByRole('img', { name: /Token 使用量/ }))
  fireEvent.click(screen.getByRole('button', { name: '7 天', exact: true }))
  await waitFor(() => assert.equal(filter.disabled, false))
  assert.equal(screen.getAllByRole('img').length, 4)
  fireEvent.change(filter, { target: { value: 'gpt-future' } })
  assert.deepEqual(values(), ['240', '3', '40.00%', '--'])
  assert.equal(screen.getAllByRole('img').length, 2)
  assert.equal(result.container.querySelectorAll('.bar-cached').length, 2)
  fireEvent.change(filter, { target: { value: '' } })
  assert.deepEqual(values().slice(0, 3), ['360', '4', '40.00%'])
})

test('GPT-6.2 mode rates appear in model costs and filtered summaries', async () => {
  const tokens = { cachedTokens: 1_000_000, uncachedTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 }
  const usage = { ...bucket, ...tokens }
  const models = [
    { model: 'gpt-6.2-astra', buckets: [{ ...usage, acceleratedUsage: { fast: tokens } }] },
    { model: 'gpt-6.2-sol', buckets: [{ ...usage, acceleratedUsage: { ultrafastPromotional: tokens } }] },
    { model: 'gpt-6.1-sol', buckets: [usage] },
  ]
  mount([account], async (input) => ({ ...input, updatedAt: Date.now(), mode: 'live', localUsage: { status: 'ready' }, models }))
  fireEvent.click(screen.getByRole('button', { name: '账户与筛选' }))
  const filter = await screen.findByRole('combobox', { name: '筛选模型' })
  await waitFor(() => assert.equal(filter.disabled, false))
  const summary = screen.getByRole('region', { name: '用量摘要' })
  assert.ok(summary.textContent.includes('$175.20'))
  assert.equal(screen.queryByText(/以下模型未计入金额/), null)
  fireEvent.click(screen.getByText(/^模型明细/, { selector: 'summary' }))
  for (const [name, id, cost, rate] of [
    ['GPT-6.2-Astra', 'gpt-6.2-astra', '$116.80', /Fast.*输入 16.*输出 80/],
    ['GPT-6.2-Sol', 'gpt-6.2-sol', '$43.80', /Ultrafast（优惠）.*输入 6.*输出 30/],
  ]) {
    const model = screen.getByRole('button', { name, exact: true })
    assert.match(within(model.closest('tr')).getByText(cost).title, rate)
    fireEvent.click(model)
    assert.equal(filter.value, id)
    assert.ok(summary.textContent.includes(cost))
    fireEvent.click(model)
    assert.equal(filter.value, '')
    assert.ok(summary.textContent.includes('$175.20'))
  }
})
test('account dialog traps focus, closes with Escape and restores focus', async () => {
  const { AccountDialog } = require('../src/components/AccountDialog.tsx')
  function Example() { const [open, setOpen] = React.useState(false); return React.createElement(React.Fragment, null, React.createElement('button', { onClick: () => setOpen(true) }, 'open'), open && React.createElement(AccountDialog, { busy: false, onClose: () => setOpen(false) }, React.createElement('button', null, 'last'))) }
  render(React.createElement(Example))
  const trigger = screen.getByText('open'); trigger.focus(); fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog')
  assert.equal(document.activeElement, dialog)
  const last = screen.getByText('last'); last.focus(); fireEvent.keyDown(last, { key: 'Tab' })
  assert.equal(document.activeElement, screen.getByRole('button', { name: '关闭' }))
  fireEvent.keyDown(document.activeElement, { key: 'Escape' })
  assert.equal(screen.queryByRole('dialog'), null)
  assert.equal(document.activeElement, trigger)
})
test('stacked chart follows reference series order without double counting reasoning', () => {
  const { TokensChart } = require('../src/components/UsageCharts.tsx')
  const result = render(React.createElement(TokensChart, { range: '7d', buckets: [bucket, { ...bucket, timestamp: bucket.timestamp + 86400000, cachedTokens: 1, uncachedTokens: 99, outputTokens: 120 }] }))
  const outputs = [...result.container.querySelectorAll('.bar-output')]
  const orders = outputs.map((item) => [...item.parentElement.querySelectorAll('rect')].map((rect) => rect.getAttribute('class')))
  assert.deepEqual(orders[0], orders[1])
  assert.deepEqual(orders[0].slice(0, 5), ['bar-uncached', 'bar-output', 'bar-reasoning', 'bar-cached', 'bar-cache-write'])
  const chart = screen.getByRole('img')
  fireEvent.focus(chart); fireEvent.keyDown(chart, { key: 'End' })
  const detail = screen.getByRole('tooltip')
  assert.ok(within(detail).getByText('220'))
  assert.deepEqual([...detail.querySelectorAll('.chart-tooltip-row')].map((row) => [row.querySelector('span').textContent, row.querySelector('b').textContent]), [
    ['缓存命中', '1 · 1.00%'], ['未缓存输入', '99'], ['缓存写入', '0'], ['输出', '115'], ['推理', '5'],
  ])
  fireEvent.keyDown(chart, { key: 'Escape' })
  assert.equal(screen.queryByRole('tooltip'), null)
})

test('request line chart exposes per-bucket details and closes on pointer leave', () => {
  const { RequestsChart } = require('../src/components/UsageCharts.tsx')
  const result = render(React.createElement(RequestsChart, { range: '7d', requestLabel: '用量记录', buckets: [bucket, { ...bucket, timestamp: bucket.timestamp + 86400000, requestCount: 7 }] }))
  const chart = screen.getByRole('img')
  fireEvent.focus(chart)
  assert.ok(within(screen.getByRole('tooltip')).getByText('1'))
  fireEvent.keyDown(chart, { key: 'ArrowRight' })
  assert.ok(within(screen.getByRole('tooltip')).getByText('7'))
  assert.ok(within(screen.getByRole('tooltip')).getByText('条用量记录'))
  assert.ok(result.container.querySelector('polyline.request-line'))
  fireEvent.pointerLeave(result.container.querySelector('.chart-shell'))
  assert.equal(screen.queryByRole('tooltip'), null)
  fireEvent.pointerEnter(result.container.querySelector('[data-chart-index="1"]'))
  fireEvent.focus(chart)
  assert.ok(within(screen.getByRole('tooltip')).getByText('7'))
})

test('Pro demo shows only the weekly allowance and both charts for each model', async () => {
  const { createDemoSnapshot } = require('../src/data.ts')
  const demo = createDemoSnapshot('chatgpt-pro', 'subscription', '7d')
  assert.deepEqual(demo.subscription.windows.map((window) => window.limitWindowSeconds), [604800])
  mount([account], async (input) => ({ ...demo, ...input }))
  await screen.findByText('周额度')
  assert.equal(screen.queryByText('5 小时额度'), null)
  assert.equal(screen.getAllByRole('img').length, demo.models.length * 2)
})

test('Pro without a returned quota window does not invent usage', async () => {
  mount([account], async (input) => ({ ...input, updatedAt: Date.now(), mode: 'live', models: [], subscription: { planType: 'Pro', windows: [] } }))
  await screen.findByText('官方接口未返回可展示的额度窗口。')
  assert.equal(screen.queryByText('5 小时额度'), null)
  assert.equal(screen.queryByRole('progressbar'), null)
})
