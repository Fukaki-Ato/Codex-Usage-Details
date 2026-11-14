require('./ts-loader.cjs')
const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const name of ['window', 'document', 'HTMLElement', 'SVGElement', 'SVGSVGElement', 'Node', 'MutationObserver']) globalThis[name] = name === 'window' ? dom.window : name === 'document' ? dom.window.document : dom.window[name]
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
const React = require('react')
const { render, screen, fireEvent, waitFor, cleanup } = require('@testing-library/react')
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
  assert.ok(screen.getByText(/2026.*缓存/))
  assert.equal(screen.queryByText('5 小时额度'), null)
  assert.ok(screen.getByText('周额度'))
  assert.ok(screen.getByRole('button', { name: '管理账户', exact: true }))
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
test('stacked chart partitions output and keeps semantic segment order', () => {
  const { TokensChart } = require('../src/components/UsageCharts.tsx')
  const result = render(React.createElement(TokensChart, { range: '7d', buckets: [bucket, { ...bucket, cachedTokens: 1, uncachedTokens: 99, outputTokens: 120 }] }))
  const outputs = [...result.container.querySelectorAll('.bar-output')]
  const orders = outputs.map((item) => [...item.parentElement.querySelectorAll('rect')].map((rect) => rect.getAttribute('class')))
  assert.deepEqual(orders[0], orders[1])
  const chart = screen.getByRole('img')
  fireEvent.focus(chart); fireEvent.keyDown(chart, { key: 'End' })
  assert.ok(result.container.querySelector('.token-tooltip-group'))
  assert.ok(screen.getByText('可见输出'))
})
