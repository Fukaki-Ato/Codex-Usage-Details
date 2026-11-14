const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')

function load(file, mocks, extras = {}) {
  const filename = path.resolve(__dirname, '../electron', file)
  const normal = createRequire(filename)
  const sandbox = { module: { exports: {} }, __dirname: path.dirname(filename), __filename: filename, require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : normal(id), process, Buffer, URL, URLSearchParams, AbortController, Error, console, setTimeout, clearTimeout, ...extras }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  return sandbox.module.exports
}
const tick = () => new Promise(setImmediate)

test('aborting an HTTP request closes the transport and rejects promptly', async () => {
  let aborted = false
  const request = new EventEmitter()
  request.end = () => {}
  request.abort = () => { aborted = true; request.emit('error', new Error('aborted')) }
  const http = load('http.cjs', { electron: { net: { request: () => request }, session: { defaultSession: {} } } })
  const controller = new AbortController()
  const result = http.requestText('https://example.invalid', { signal: controller.signal })
  controller.abort()
  await assert.rejects(result, /取消/)
  assert.equal(aborted, true)
})

test('relogin preserves log directory and accounts cannot share a directory', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-storage-test-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const storage = load('storage.cjs', { electron: { app: { getPath: () => root }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(text), decryptString: (data) => data.toString() } } })
  const credentials = { email: 'synthetic@example.invalid', accountId: 'one', planType: 'Pro', accessToken: 'fake', refreshToken: 'fake' }
  const one = await storage.upsertSubscriptionAccount(credentials)
  assert.equal(one.codexHome, undefined)
  await storage.setCodexHome(one.id, root)
  const again = await storage.upsertSubscriptionAccount(credentials)
  assert.equal(again.id, one.id)
  assert.equal(again.codexHome, await fsp.realpath(root))
  const two = await storage.upsertSubscriptionAccount({ ...credentials, accountId: 'two' })
  await assert.rejects(storage.setCodexHome(two.id, root), /其他账户/)
  await storage.removeAccount(two.id)
  assert.equal((await storage.listAccounts()).length, 1)
})

test('snapshot cache expires, separates accounts, coalesces requests and invalidates', async () => {
  let now = Date.now(), requests = 0
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } }
  const usage = load('usage.cjs', {
    './storage.cjs': { getAccount: async () => ({}), getSecret: async () => ({ secret: { apiKey: 'synthetic' } }) },
    './http.cjs': { requestText: async () => { requests++; await tick(); return { statusCode: 200, body: '{"data":[]}' } } },
  }, { Date: Clock })
  const input = { accountId: 'one', source: 'api', range: '7d' }
  const [first] = await Promise.all([usage.getUsage(input), usage.getUsage(input)])
  assert.equal(requests, 1)
  now += 1000
  const cached = await usage.getUsage(input)
  assert.equal(cached.updatedAt, first.updatedAt)
  assert.equal(cached.cache.hit, true)
  await usage.getUsage({ ...input, accountId: 'two' })
  assert.equal(requests, 2)
  now += 61000
  await usage.getUsage(input)
  assert.equal(requests, 3)
  usage.invalidateAccount('one')
  await usage.getUsage(input)
  assert.equal(requests, 4)
})

test('subscription logs require a directory and report read failures separately from empty data', async () => {
  let home
  const usage = load('usage.cjs', {
    './storage.cjs': { getAccount: async () => ({}), listAccounts: async () => [{ id: 'one', codexHome: home }] },
    'node:fs/promises': { realpath: async (value) => value },
    './auth.cjs': { getSubscriptionCredentials: async () => ({ account: { remoteAccountId: 'one', codexHome: home }, secret: { accessToken: 'fake' } }) },
    './http.cjs': { requestText: async () => ({ statusCode: 200, body: JSON.stringify({ rate_limit: { secondary_window: { used_percent: 28, limit_window_seconds: 604800 } } }) }) },
    './local-usage.cjs': { fetchLocalCodexModelUsage: async () => { throw new Error('模拟磁盘错误') }, localRowsToModels: () => [] },
  })
  const input = { accountId: 'one', source: 'subscription', range: '7d' }
  assert.equal((await usage.getUsage(input)).localUsage.status, 'unconfigured')
  home = path.resolve('synthetic')
  usage.invalidateAccount('one')
  const result = await usage.getUsage(input)
  assert.equal(result.localUsage.status, 'error')
  assert.match(result.localUsage.warning, /磁盘错误/)
  assert.equal(result.subscription.windows[0].id, 'secondary')
})

test('cancelled OAuth exchange cannot save a late response', async () => {
  let server, url, release, saved = 0
  const auth = load('auth.cjs', {
    'node:http': { createServer() { server = new EventEmitter(); server.listen = () => queueMicrotask(() => server.emit('listening')); server.close = () => {}; return server } },
    electron: { shell: { openExternal: async (value) => { url = value } } },
    './storage.cjs': { upsertSubscriptionAccount: async () => { saved++; return {} } },
    './http.cjs': { requestText: () => new Promise((resolve) => { release = resolve }) },
  })
  const login = auth.startSubscriptionLogin().catch((error) => error)
  await tick()
  const callback = server.listeners('request')[0]({ url: '/auth/callback?code=test&state=' + new URL(url).searchParams.get('state') }, { writeHead() {}, end() {} })
  assert.equal(auth.cancelSubscriptionLogin(), true)
  assert.match((await login).message, /取消/)
  release({ statusCode: 200, body: JSON.stringify({ id_token: 'fake', access_token: 'fake', refresh_token: 'fake' }) })
  await callback
  assert.equal(saved, 0)
})

test('runtime directory aliases pause statistics rather than mixing accounts', async () => {
  const usage = load('usage.cjs', {
    './storage.cjs': { getAccount: async () => ({}), listAccounts: async () => [{ id: 'one', codexHome: 'alias' }, { id: 'two', codexHome: 'real' }] },
    'node:fs/promises': { realpath: async () => 'same-canonical-directory' },
    './auth.cjs': { getSubscriptionCredentials: async () => ({ account: { remoteAccountId: 'one', codexHome: 'alias' }, secret: { accessToken: 'fake' } }) },
    './http.cjs': { requestText: async () => ({ statusCode: 200, body: '{"rate_limit":{"primary_window":{"used_percent":1}}}' }) },
    './local-usage.cjs': { fetchLocalCodexModelUsage: async () => { throw new Error('must not scan shared logs') }, localRowsToModels: () => [] },
  })
  const result = await usage.getUsage({ accountId: 'one', source: 'subscription', range: '7d' })
  assert.equal(result.localUsage.status, 'unconfigured')
  assert.match(result.localUsage.warning, /重复/)
  assert.equal(result.models.length, 0)
})

test('simultaneous credential refreshes share one exchange', async () => {
  let requests = 0
  const auth = load('auth.cjs', {
    electron: { shell: {} },
    './storage.cjs': { getSecret: async () => ({ account: { id: 'one' }, secret: { refreshToken: 'fake' } }), updateSubscriptionSecret: async () => ({ id: 'one' }) },
    './http.cjs': { requestText: async () => { requests++; await tick(); return { statusCode: 200, body: '{"access_token":"fake","expires_in":3600}' } } },
  })
  await Promise.all([auth.getSubscriptionCredentials('one'), auth.getSubscriptionCredentials('one')])
  assert.equal(requests, 1)
})

test('late browser failure from a cancelled login cannot close the next login', async () => {
  const servers = []
  let rejectFirst, opens = 0
  const auth = load('auth.cjs', {
    'node:http': { createServer() { const server = new EventEmitter(); server.closed = false; server.listen = () => queueMicrotask(() => server.emit('listening')); server.close = () => { server.closed = true }; servers.push(server); return server } },
    electron: { shell: { openExternal: () => ++opens === 1 ? new Promise((_, reject) => { rejectFirst = reject }) : Promise.resolve() } },
    './storage.cjs': {}, './http.cjs': {},
  })
  const first = auth.startSubscriptionLogin().catch((error) => error)
  await tick(); auth.cancelSubscriptionLogin()
  const second = auth.startSubscriptionLogin().catch((error) => error)
  await tick(); rejectFirst(new Error('模拟浏览器失败')); await first
  const closed = servers[1].closed
  auth.cancelSubscriptionLogin()
  if (!closed) await second
  assert.equal(closed, false)
})

test('legacy directory aliases cannot be assigned to a second account', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-alias-test-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const real = path.join(root, 'logs'), alias = path.join(root, 'alias')
  await fsp.mkdir(real); await fsp.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await fsp.writeFile(path.join(root, 'accounts.json'), JSON.stringify({ version: 1, accounts: [{ id: 'one', kind: 'subscription', codexHome: alias }, { id: 'two', kind: 'subscription' }] }))
  const storage = load('storage.cjs', { electron: { app: { getPath: () => root }, safeStorage: {} } })
  await assert.rejects(storage.setCodexHome('two', real), /其他账户/)
})

test('npm start loads built files and only explicit --dev uses the server', async () => {
  for (const dev of [false, true]) {
    let loaded
    class Window { constructor() { this.webContents = { on() {}, setWindowOpenHandler() {} } } removeMenu() {} loadURL(url) { loaded = url } loadFile(file) { loaded = file } }
    load('main.cjs', { electron: { app: { isPackaged: false, whenReady: () => Promise.resolve(), on() {} }, BrowserWindow: Window, Menu: { setApplicationMenu() {} } }, './ipc.cjs': { registerIpc() {} }, './http.cjs': { configureNetworkProxy: async () => {} } }, { process: { platform: 'win32', argv: dev ? ['electron', '.', '--dev'] : ['electron', '.'] } })
    await tick()
    assert.match(loaded, dev ? /127\.0\.0\.1:5173/ : /dist[\\/]index\.html/)
  }
})
