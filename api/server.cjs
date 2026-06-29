'use strict'

/**
 * Standalone ZTPKI proxy server.
 *
 * Exposes a single endpoint, POST /ztpki, that signs a ZTPKI (Venafi Zero Touch
 * PKI / HydrantID ACM) REST call with the caller's HAWK credentials server-side
 * and forwards it. The HAWK secret is used only to sign the request and is never
 * logged or stored. See ./ztpki.cjs for the HAWK signing + SSRF guard.
 */

const http = require('http')
const { URL } = require('url')
const ztpki = require('./ztpki.cjs')

const PORT = Number(process.env.PORT) || 3001
const HOST = process.env.HOST || '127.0.0.1'

const ZTPKI_METHODS = ['GET', 'POST', 'PATCH']
const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max

// Reject non-public hostnames to prevent SSRF.
function isPrivateHost(hostname) {
  return (
    /^localhost$/i.test(hostname) ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^::1$/.test(hostname) ||
    /^0\.0\.0\.0$/.test(hostname) ||
    /^169\.254\./.test(hostname)
  )
}

function validateZtpkiInput(b) {
  if (!b || typeof b !== 'object') return 'Invalid request body'
  if (!isStr(b.hawkId, 512)) return 'hawkId is required'
  if (!isStr(b.hawkKey, 4096)) return 'hawkKey is required'
  if (!isStr(b.baseUrl, 2048)) return 'baseUrl is required'

  let u
  try { u = new URL(b.baseUrl) } catch { return `Invalid baseUrl: ${b.baseUrl}` }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'baseUrl must use http or https'
  if (isPrivateHost(u.hostname)) return 'Private/internal ZTPKI addresses are not allowed by this proxy'

  const method = (b.method || 'GET').toUpperCase()
  if (!ZTPKI_METHODS.includes(method)) return `method must be one of ${ZTPKI_METHODS.join(', ')}`

  // Path allow-list: certificate lifecycle + account/org discovery.
  const ALLOWED_PREFIXES = ['/certificates', '/accounts', '/organizations']
  if (!isStr(b.path, 512) || !ALLOWED_PREFIXES.some(p => b.path.startsWith(p))) {
    return `path must start with one of: ${ALLOWED_PREFIXES.join(', ')}`
  }
  if (b.path.includes('..') || b.path.includes('//')) return 'Invalid path'
  if (b.body !== undefined && b.body !== null && typeof b.body !== 'object') {
    return 'body must be a JSON object'
  }
  return null
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  let url
  try { url = new URL(req.url, 'http://localhost') } catch {
    res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid request URL' })); return
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200); res.end(JSON.stringify({ ok: true })); return
  }

  if (url.pathname === '/ztpki' && req.method === 'POST') {
    let rawBody = ''
    let tooBig = false
    req.on('data', chunk => {
      rawBody += chunk
      if (rawBody.length > 64 * 1024) { tooBig = true; req.destroy() }
    })
    req.on('end', async () => {
      if (tooBig) {
        res.writeHead(413); res.end(JSON.stringify({ error: 'Request body too large' })); return
      }
      try {
        const body = JSON.parse(rawBody)
        const errs = validateZtpkiInput(body)
        if (errs) { res.writeHead(400); res.end(JSON.stringify({ error: errs })); return }
        // HAWK creds are used only to sign this request; never logged or stored.
        const result = await ztpki.call({
          baseUrl: body.baseUrl.trim(),
          path: body.path,
          method: (body.method || 'GET').toUpperCase(),
          body: body.body,
          hawkId: body.hawkId,
          hawkKey: body.hawkKey,
          insecureTLS: body.insecureTLS === true,
        })
        res.writeHead(result.status || 502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result.json !== null ? result.json : { raw: result.raw, status: result.status }))
      } catch (e) {
        res.writeHead(502); res.end(JSON.stringify({ error: e.message || 'ZTPKI request failed' }))
      }
    })
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'Not found. Use POST /ztpki' }))
})

server.listen(PORT, HOST, () => {
  console.log(`ZTPKI proxy listening on http://${HOST}:${PORT}`)
})
