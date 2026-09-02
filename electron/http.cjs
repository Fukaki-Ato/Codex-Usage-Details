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

function requestText(url, { method = 'GET', headers = {}, body, timeout = 30_000, maxResponseBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
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
      request.abort()
      finish(new Error('官方请求超时，请检查网络或代理设置。'))
    }, timeout)

    function finish(error, result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(result)
    }

    request.on('response', (response) => {
      const chunks = []
      response.on('data', (chunk) => {
        if (settled) return
        responseBytes += chunk.length
        if (responseBytes > maxResponseBytes) {
          request.abort()
          finish(new Error('官方响应过大，已停止读取。'))
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
