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

test('a temporarily closed GET connection is retried once', async () => {
  let attempts = 0
  const http = load('http.cjs', { electron: {
    session: { defaultSession: {} },
    net: { request: () => {
      const request = new EventEmitter()
      request.abort = () => {}
      request.end = () => queueMicrotask(() => {
        if (++attempts === 1) { request.emit('error', new Error('net::ERR_CONNECTION_CLOSED')); return }
        const response = new EventEmitter(); response.statusCode = 200; response.headers = {}
        request.emit('response', response); response.emit('data', Buffer.from('{}')); response.emit('end')
      })
      return request
    } },
  } })
  assert.equal((await http.requestText('https://example.invalid')).statusCode, 200)
  assert.equal(attempts, 2)
})

test('token POST requests are not retried; persistent errors are readable', async () => {
  let attempts = 0
  const http = load('http.cjs', { electron: { session: { defaultSession: {} }, net: { request: () => {
    const request = new EventEmitter(); request.abort = () => {}; request.write = () => {}
    request.end = () => queueMicrotask(() => { attempts++; request.emit('error', new Error('net::ERR_CONNECTION_CLOSED')) })
    return request
  } } } })
  await assert.rejects(http.requestText('https://example.invalid', { method: 'POST', body: 'synthetic' }), /连接.*关闭/)
  assert.equal(attempts, 1)
})

test('persistent GET disconnects stop after two attempts', async () => {
  let attempts = 0
  const http = load('http.cjs', { electron: { session: { defaultSession: {} }, net: { request: () => {
    const request = new EventEmitter(); request.abort = () => {}
    request.end = () => queueMicrotask(() => { attempts++; request.emit('error', new Error('net::ERR_CONNECTION_RESET')) })
    return request
  } } } })
  await assert.rejects(http.requestText('https://example.invalid'), /连接.*中断/)
  assert.equal(attempts, 2)
})

test('cancelling during retry backoff prevents another request', async () => {
  let attempts = 0
  const http = load('http.cjs', { electron: { session: { defaultSession: {} }, net: { request: () => {
    const request = new EventEmitter(); request.abort = () => {}
    request.end = () => queueMicrotask(() => { attempts++; request.emit('error', new Error('net::ERR_CONNECTION_CLOSED')) })
    return request
  } } } })
  const controller = new AbortController()
  const result = http.requestText('https://example.invalid', { signal: controller.signal })
  await tick()
  controller.abort()
  await assert.rejects(result, /取消/)
  assert.equal(attempts, 1)
})

test('response disconnect retries with a fresh body buffer', async () => {
  let attempts = 0
  const http = load('http.cjs', { electron: { session: { defaultSession: {} }, net: { request: () => {
    const request = new EventEmitter(); request.abort = () => {}
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = 200; response.headers = {}
      request.emit('response', response)
      if (++attempts === 1) { response.emit('data', Buffer.from('partial')); response.emit('error', new Error('net::ERR_CONNECTION_CLOSED')) }
      else { response.emit('data', Buffer.from('complete')); response.emit('end') }
    })
    return request
  } } } })
  assert.equal((await http.requestText('https://example.invalid')).body, 'complete')
  assert.equal(attempts, 2)
})

test('timeout and size-limit errors survive synchronous transport abort errors', async () => {
  for (const sizeLimit of [false, true]) {
    let attempts = 0
    const http = load('http.cjs', { electron: { session: { defaultSession: {} }, net: { request: () => {
      attempts++
      const request = new EventEmitter()
      request.abort = () => request.emit('error', new Error('net::ERR_CONNECTION_CLOSED'))
      request.end = () => {
        if (!sizeLimit) return
        const response = new EventEmitter()
        request.emit('response', response); response.emit('data', Buffer.from('large'))
      }
      return request
    } } } })
    await assert.rejects(http.requestText('https://example.invalid', { timeout: 5, maxResponseBytes: 1 }), sizeLimit ? /响应过大/ : /超时/)
    assert.equal(attempts, 1)
  }
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

test('API usage groups by model and tier on each page and splits the Ultrafast price transition', async () => {
  const cutover = Date.parse('2027-03-01T08:00:00Z') / 1000
  const dayStart = Date.parse('2027-03-01T00:00:00Z') / 1000
  const now = (cutover + 3600) * 1000
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } }
  const requests = []
  const usage = load('usage.cjs', {
    './storage.cjs': { getAccount: async () => ({}), getSecret: async () => ({ secret: { apiKey: 'synthetic' } }) },
    './http.cjs': { requestText: async (url) => {
      const query = new URL(url).searchParams
      requests.push(query)
      const before = Number(query.get('end_time')) === cutover
      const firstPage = before && !query.has('page')
      const data = firstPage ? [] : [{ start_time: dayStart, results: [
        { model: 'gpt-6.2-astra', service_tier: 'ultrafast', input_tokens: before ? 10 : 20, num_model_requests: 1 },
      ] }]
      return { statusCode: 200, body: JSON.stringify({ data, has_more: firstPage, next_page: firstPage ? 'next' : null }) }
    } },
  }, { Date: Clock })

  const result = await usage.getUsage({ accountId: 'one', source: 'api', range: '7d' })
  assert.equal(requests.length, 3)
  for (const query of requests) assert.deepEqual(query.getAll('group_by[]'), ['model', 'service_tier'])
  assert.equal(requests[0].get('end_time'), String(cutover))
  assert.equal(requests[1].get('page'), 'next')
  assert.equal(requests[2].get('start_time'), String(cutover))
  assert.equal(requests[2].has('page'), false)
  const [row] = result.models[0].buckets.filter((bucket) => bucket.requestCount > 0)
  assert.equal(row.requestCount, 2)
  assert.equal(row.uncachedTokens, 30)
  assert.equal(row.acceleratedUsage.ultrafastPromotional.uncachedTokens, 10)
  assert.equal(row.acceleratedUsage.ultrafastList.uncachedTokens, 20)
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
  const unconfigured = await usage.getUsage(input)
  assert.equal(unconfigured.localUsage.status, 'unconfigured')
  assert.match(unconfigured.notice, /请先配置/)
  home = path.resolve('synthetic')
  usage.invalidateAccount('one')
  const result = await usage.getUsage(input)
  assert.equal(result.localUsage.status, 'error')
  assert.match(result.localUsage.warning, /磁盘错误/)
  assert.equal(result.subscription.windows[0].id, 'secondary')
  assert.match(result.notice, /暂不可用/)
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
    let appUserModelId
    class Window { constructor() { this.webContents = { on() {}, setWindowOpenHandler() {} } } removeMenu() {} loadURL(url) { loaded = url } loadFile(file) { loaded = file } }
    const app = {
      isPackaged: false,
      whenReady: () => Promise.resolve(),
      on() {},
      setAppUserModelId(id) { appUserModelId = id },
    }
    load('main.cjs', { electron: { app, BrowserWindow: Window, Menu: { setApplicationMenu() {} } }, './ipc.cjs': { registerIpc() {} }, './http.cjs': { configureNetworkProxy: async () => {} } }, { process: { platform: 'win32', argv: dev ? ['electron', '.', '--dev'] : ['electron', '.'] } })
    await tick()
    assert.equal(appUserModelId, require('../package.json').build.appId)
    assert.match(loaded, dev ? /127\.0\.0\.1:5173/ : /dist[\\/]index\.html/)
  }
})
