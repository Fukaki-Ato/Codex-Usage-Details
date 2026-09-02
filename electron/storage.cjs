const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { app, safeStorage } = require('electron')

const STORE_VERSION = 1
let storeCache
let mutationQueue = Promise.resolve()

function storePath() {
  return path.join(app.getPath('userData'), 'accounts.json')
}

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

function assertSecureStorage() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统未提供可用的安全凭据存储，未保存任何账户信息。')
  }
}

async function loadStore() {
  if (storeCache) return storeCache

  try {
    const content = await fs.readFile(storePath(), 'utf8')
    const parsed = JSON.parse(content)
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.accounts)) {
      throw new Error('账户存储格式不受支持。')
    }
    storeCache = parsed
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    storeCache = { version: STORE_VERSION, accounts: [] }
  }

  return storeCache
}

async function saveStore(store) {
  const file = storePath()
  const directory = path.dirname(file)
  const tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(tempFile, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(tempFile, file)
  storeCache = store
}

function mutateStore(mutator) {
  const operation = mutationQueue.then(async () => {
    const store = await loadStore()
    const nextStore = await mutator(store)
    await saveStore(nextStore)
    return nextStore
  })
  mutationQueue = operation.catch(() => undefined)
  return operation
}

function encryptSecret(secret) {
  assertSecureStorage()
  return safeStorage.encryptString(JSON.stringify(secret)).toString('base64')
}

function decryptSecret(encoded) {
  assertSecureStorage()
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(encoded, 'base64')))
  } catch {
    throw new Error('账户凭据无法解密，可能已被系统凭据重置。请重新连接该账户。')
  }
}

function toPublicAccount(record) {
  const isApi = record.kind === 'api'
  return {
    id: record.id,
    name: record.name,
    detail: record.detail,
    sources: [isApi ? 'api' : 'subscription'],
    status: 'connected',
    email: record.email || undefined,
    planType: record.planType || undefined,
    codexHome: record.kind === 'subscription' ? record.codexHome || defaultCodexHome() : undefined,
  }
}

async function listAccounts() {
  await mutationQueue
  const store = await loadStore()
  return store.accounts.map(toPublicAccount)
}

async function getAccount(accountId, kind) {
  await mutationQueue
  const store = await loadStore()
  const account = store.accounts.find((item) => item.id === accountId && (!kind || item.kind === kind))
  if (!account) throw new Error('找不到所选账户。')
  return account
}

async function getSecret(accountId, kind) {
  const account = await getAccount(accountId, kind)
  return { account, secret: decryptSecret(account.secret) }
}

async function addApiAccount({ name, apiKey, organizationId }) {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error('API Key 不能为空。')
  }
  const cleanName = typeof name === 'string' && name.trim() ? name.trim() : 'OpenAI API'
  const cleanOrganizationId = typeof organizationId === 'string' ? organizationId.trim() : ''
  const account = {
    id: randomUUID(),
    kind: 'api',
    name: cleanName,
    detail: cleanOrganizationId ? `组织 ${cleanOrganizationId}` : 'API 账户',
    createdAt: new Date().toISOString(),
    secret: encryptSecret({
      apiKey: apiKey.trim(),
      organizationId: cleanOrganizationId,
    }),
  }
  await mutateStore((store) => ({ ...store, accounts: [...store.accounts, account] }))
  return toPublicAccount(account)
}

async function upsertSubscriptionAccount({ email, planType, accountId, idToken, accessToken, refreshToken, accessTokenExpiresAt }) {
  if (!accessToken || !refreshToken) throw new Error('官方登录未返回可刷新的凭据。')
  const account = {
    id: randomUUID(),
    kind: 'subscription',
    name: planType ? `ChatGPT ${planType}` : 'ChatGPT 订阅',
    detail: email || '官方订阅账户',
    email: email || '',
    planType: planType || 'Unknown',
    remoteAccountId: accountId || '',
    createdAt: new Date().toISOString(),
    secret: encryptSecret({ idToken, accessToken, refreshToken, accessTokenExpiresAt }),
  }
  let savedAccount
  await mutateStore((store) => {
    const existing = store.accounts.find((item) => item.kind === 'subscription' && item.remoteAccountId === accountId && accountId)
    savedAccount = existing ? { ...account, id: existing.id, createdAt: existing.createdAt } : account
    const accounts = existing
      ? store.accounts.map((item) => item.id === existing.id ? savedAccount : item)
      : [...store.accounts, savedAccount]
    return { ...store, accounts }
  })
  return toPublicAccount(savedAccount)
}

async function updateSubscriptionSecret(account, secret, metadata = {}) {
  let nextAccount
  await mutateStore((store) => {
    const current = store.accounts.find((item) => item.id === account.id)
    if (!current) throw new Error('找不到需要更新的订阅账户。')
    nextAccount = { ...current, ...metadata, secret: encryptSecret(secret) }
    return {
      ...store,
      accounts: store.accounts.map((item) => item.id === account.id ? nextAccount : item),
    }
  })
  return nextAccount
}

async function removeAccount(accountId) {
  let removed = false
  await mutateStore((store) => {
    const nextAccounts = store.accounts.filter((item) => item.id !== accountId)
    removed = nextAccounts.length !== store.accounts.length
    return { ...store, accounts: nextAccounts }
  })
  return removed
}

async function setCodexHome(accountId, codexHome) {
  if (typeof codexHome !== 'string' || !codexHome.trim()) throw new Error('Codex 数据目录不能为空。')
  const cleanCodexHome = path.resolve(codexHome.trim())
  let nextAccount
  await mutateStore((store) => {
    const current = store.accounts.find((item) => item.id === accountId && item.kind === 'subscription')
    if (!current) throw new Error('只能为订阅账户设置 Codex 数据目录。')
    nextAccount = { ...current, codexHome: cleanCodexHome }
    return { ...store, accounts: store.accounts.map((item) => item.id === accountId ? nextAccount : item) }
  })
  return toPublicAccount(nextAccount)
}

module.exports = {
  addApiAccount,
  decryptSecret,
  getAccount,
  getSecret,
  listAccounts,
  removeAccount,
  setCodexHome,
  toPublicAccount,
  updateSubscriptionSecret,
  upsertSubscriptionAccount,
}
