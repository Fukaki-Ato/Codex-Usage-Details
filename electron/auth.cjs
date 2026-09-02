const http = require('node:http')
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto')
const { shell } = require('electron')
const storage = require('./storage.cjs')
const { requestText } = require('./http.cjs')

const ISSUER = 'https://auth.openai.com'
const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const ORIGINATOR = 'codex_cli_rs'
const LIFE_SCIENCES_STATE_SUFFIX = '.onboarding_entrypoint=life_sciences'
let activeLogin

function base64Url(buffer) {
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function createPkce() {
  const verifier = base64Url(randomBytes(64))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function createState() {
  return base64Url(randomBytes(32))
}

function parseJwt(jwt) {
  try {
    const payload = jwt.split('.')[1]
    if (!payload) return {}
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

function tokenProfile(idToken) {
  const claims = parseJwt(idToken)
  const auth = claims['https://api.openai.com/auth'] || {}
  const profile = claims['https://api.openai.com/profile'] || {}
  return {
    email: claims.email || profile.email || '',
    planType: auth.chatgpt_plan_type || '',
    accountId: auth.chatgpt_account_id || auth.account_id || claims.account_id || '',
    expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : undefined,
  }
}

function buildAuthorizeUrl(port, state, pkce) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: `http://localhost:${port}/auth/callback`,
    scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: ORIGINATOR,
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

function openCallbackServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve(server)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

async function listenOnRegisteredPort() {
  try {
    return { server: await openCallbackServer(1455), port: 1455 }
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error
    await cancelStaleLogin(1455)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      try {
        return { server: await openCallbackServer(1455), port: 1455 }
      } catch (retryError) {
        if (retryError.code !== 'EADDRINUSE') throw retryError
      }
    }
    return { server: await openCallbackServer(1457), port: 1457 }
  }
}

function cancelStaleLogin(port) {
  return new Promise((resolve) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/cancel', method: 'GET', timeout: 1_000 }, (response) => {
      response.resume()
      resolve(true)
    })
    request.on('error', () => resolve(false))
    request.on('timeout', () => {
      request.destroy()
      resolve(false)
    })
    request.end()
  })
}

function writeResponse(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'close',
  })
  response.end(body)
}

function oauthErrorDetail(payload) {
  const detail = typeof payload?.error_description === 'string'
    ? payload.error_description
    : typeof payload?.error === 'string'
      ? payload.error
      : typeof payload?.error?.message === 'string'
        ? payload.error.message
        : ''
  return detail.replace(/[\r\n]+/g, ' ').trim().slice(0, 240)
}

function compareState(expected, actual) {
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(actual || '')
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
}

function isValidCallbackState(expected, actual) {
  return compareState(expected, actual)
    || compareState(`${expected}${LIFE_SCIENCES_STATE_SUFFIX}`, actual)
}

async function exchangeCode(code, redirectUri, verifier) {
  const response = await requestText(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  })
  const body = response.body
  let payload = {}
  try {
    payload = JSON.parse(body || '{}')
  } catch {
    payload = {}
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const detail = oauthErrorDetail(payload)
    throw new Error(`官方登录交换失败（HTTP ${response.statusCode}${detail ? `：${detail}` : ''}）。`)
  }
  if (!payload.id_token || !payload.access_token || !payload.refresh_token) {
    throw new Error('官方登录响应缺少必要凭据。')
  }
  return payload
}

async function startSubscriptionLogin() {
  if (activeLogin) throw new Error('已有一个官方登录流程正在进行。')
  const { server, port } = await listenOnRegisteredPort()
  const state = createState()
  const pkce = createPkce()
  const redirectUri = `http://localhost:${port}/auth/callback`
  const authUrl = buildAuthorizeUrl(port, state, pkce)

  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close()
      activeLogin = undefined
      reject(new Error('官方登录等待超时，请重新开始登录。'))
    }, 15 * 60 * 1000)
    activeLogin = { server, reject, timeout }
    server.on('request', async (request, response) => {
      const requestUrl = new URL(request.url || '/', `http://localhost:${port}`)
      if (requestUrl.pathname === '/cancel') {
        writeResponse(response, 200, '<h1>登录流程已取消</h1><p>可以关闭此页面。</p>')
        clearTimeout(timeout)
        server.close()
        activeLogin = undefined
        reject(new Error('官方登录已被新的登录流程取消。'))
        return
      }
      if (requestUrl.pathname !== '/auth/callback') {
        writeResponse(response, 404, '<h1>Not Found</h1>')
        return
      }

      if (!isValidCallbackState(state, requestUrl.searchParams.get('state'))) {
        writeResponse(response, 400, '<h1>授权状态校验失败</h1><p>请关闭此页面并重新开始登录。</p>')
        // Ignore unsolicited loopback requests and keep waiting for the valid callback.
        return
      }

      const oauthError = requestUrl.searchParams.get('error')
      if (oauthError) {
        const description = requestUrl.searchParams.get('error_description') || oauthError
        writeResponse(response, 400, '<h1>授权未完成</h1><p>请返回应用重试。</p>')
        clearTimeout(timeout)
        server.close()
        activeLogin = undefined
        reject(new Error(`官方登录未完成：${description}`))
        return
      }

      const code = requestUrl.searchParams.get('code')
      if (!code) {
        writeResponse(response, 400, '<h1>授权未完成</h1><p>缺少授权码，请返回应用重试。</p>')
        clearTimeout(timeout)
        server.close()
        activeLogin = undefined
        reject(new Error('官方登录响应缺少授权码。'))
        return
      }

      try {
        const tokens = await exchangeCode(code, redirectUri, pkce.verifier)
        const profile = tokenProfile(tokens.id_token)
        const accessTokenProfile = tokenProfile(tokens.access_token)
        const account = await storage.upsertSubscriptionAccount({
          email: profile.email,
          planType: profile.planType,
          accountId: profile.accountId,
          idToken: tokens.id_token,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          accessTokenExpiresAt: accessTokenProfile.expiresAt || profile.expiresAt,
        })
        writeResponse(response, 200, '<h1>Codex Usage Details 登录成功</h1><p>可以返回桌面应用查看用量了。</p>')
        clearTimeout(timeout)
        server.close()
        activeLogin = undefined
        resolve(account)
      } catch (error) {
        writeResponse(response, 500, '<h1>登录失败</h1><p>请返回桌面应用查看错误信息并重试。</p>')
        clearTimeout(timeout)
        server.close()
        activeLogin = undefined
        reject(error instanceof Error ? error : new Error('官方登录失败。'))
      }
    })
  })

  try {
    await shell.openExternal(authUrl)
  } catch {
    if (activeLogin) {
      clearTimeout(activeLogin.timeout)
      activeLogin.server.close()
      activeLogin = undefined
    }
    throw new Error('无法打开系统浏览器，请手动打开登录地址。')
  }

  return result
}

function cancelSubscriptionLogin() {
  if (!activeLogin) return false
  const login = activeLogin
  activeLogin = undefined
  clearTimeout(login.timeout)
  login.server.close()
  login.reject(new Error('已取消官方登录。'))
  return true
}

async function refreshSubscriptionCredentials(account, secret, forceRefresh = false) {
  const expiresAt = tokenProfile(secret.accessToken || '').expiresAt || secret.accessTokenExpiresAt || tokenProfile(secret.idToken || '').expiresAt || 0
  if (!forceRefresh && expiresAt > Date.now() + 5 * 60 * 1000) return { account, secret }

  const response = await requestText(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: secret.refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  let payload = {}
  try {
    payload = JSON.parse(response.body || '{}')
  } catch {
    payload = {}
  }
  if (response.statusCode < 200 || response.statusCode >= 300 || !payload.access_token) {
    throw new Error('订阅账户授权已失效，请重新登录该账户。')
  }

  const nextSecret = {
    ...secret,
    idToken: payload.id_token || secret.idToken,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || secret.refreshToken,
    accessTokenExpiresAt: payload.expires_in
      ? Date.now() + payload.expires_in * 1000
      : tokenProfile(payload.access_token).expiresAt || tokenProfile(payload.id_token || '').expiresAt,
  }
  const profile = tokenProfile(nextSecret.idToken || '')
  const nextAccount = await storage.updateSubscriptionSecret(account, nextSecret, {
    email: profile.email || account.email,
    planType: profile.planType || account.planType,
    remoteAccountId: profile.accountId || account.remoteAccountId,
  })
  return { account: nextAccount, secret: nextSecret }
}

async function getSubscriptionCredentials(accountId, forceRefresh = false) {
  const { account, secret } = await storage.getSecret(accountId, 'subscription')
  return refreshSubscriptionCredentials(account, secret, forceRefresh)
}

async function revokeSubscriptionAccount(accountId) {
  const { secret } = await storage.getSecret(accountId, 'subscription')
  if (!secret.refreshToken) return
  const response = await requestText(`${ISSUER}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: secret.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`官方账户注销失败（HTTP ${response.statusCode}），本地账户未删除。`)
}

module.exports = {
  CHATGPT_BASE_URL,
  cancelSubscriptionLogin,
  getSubscriptionCredentials,
  revokeSubscriptionAccount,
  startSubscriptionLogin,
}
