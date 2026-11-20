const { net, session } = require('electron')

function proxyValue() {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy
}

function proxyRules(value) {
  if (!value) return null
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(parsed.protocol) || !parsed.hostname) return null
  const host = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol.startsWith('socks') ? '1080' : '80')
  if (parsed.protocol.startsWith('socks')) return `${parsed.protocol}//${host}:${port}`
  const endpoint = `${host}:${port}`
  return `http=${endpoint};https=${endpoint}`
}

async function configureNetworkProxy() {
  const rules = proxyRules(proxyValue())
  if (!rules) return false
  await session.defaultSession.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' })
  return true
}

function isTransientDisconnect(error) {
  return /ERR_CONNECTION_(?:CLOSED|RESET)|ERR_NETWORK_CHANGED|\bECONNRESET\b|\bEPIPE\b/.test(`${error?.code || ''} ${error?.message || ''}`)
}

function waitForRetry(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('请求已取消。'))
    const timer = setTimeout(() => finish(), 250)
    function finish(error) {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }
    function abort() { finish(new Error('请求已取消。')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function requestText(url, options = {}) {
  const retryable = (options.method || 'GET').toUpperCase() === 'GET' && options.body == null
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestTextOnce(url, options)
    } catch (error) {
      if (options.signal?.aborted) throw new Error('请求已取消。')
      if (!isTransientDisconnect(error)) throw error
      if (retryable && attempt === 0) {
        await waitForRetry(options.signal)
        continue
      }
      throw new Error('网络连接已关闭或中断，请检查网络或代理设置后重试。', { cause: error })
    }
  }
}

function requestTextOnce(url, { method = 'GET', headers = {}, body, signal, timeout = 30_000, maxResponseBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('请求已取消。'))
    const request = net.request({
      method,
      url,
      headers,
      session: session.defaultSession,
      redirect: 'follow',
    })
    let settled = false
    let responseBytes = 0
    const timer = setTimeout(() => {
      finish(new Error('官方请求超时，请检查网络或代理设置。'))
      request.abort()
    }, timeout)

    function finish(error, result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(result)
    }

    function abort() {
      finish(new Error('请求已取消。'))
      request.abort()
    }
    signal?.addEventListener('abort', abort, { once: true })

    request.on('response', (response) => {
      const chunks = []
      response.on('data', (chunk) => {
        if (settled) return
        responseBytes += chunk.length
        if (responseBytes > maxResponseBytes) {
          finish(new Error('官方响应过大，已停止读取。'))
          request.abort()
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      response.on('end', () => finish(null, {
        statusCode: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
      response.on('error', (error) => finish(error))
    })
    request.on('login', (_authInfo, callback) => callback())
    request.on('error', (error) => finish(error))
    if (body) request.write(body)
    request.end()
  })
}

module.exports = { configureNetworkProxy, requestText }
