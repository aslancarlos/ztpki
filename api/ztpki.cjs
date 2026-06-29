'use strict'

/**
 * ZTPKI (Venafi Zero Touch PKI / HydrantID ACM) REST proxy with HAWK auth.
 *
 * ZTPKI authenticates every call with a HAWK credential (an id + secret) and a
 * per-request HMAC-SHA256 signature. This module signs the request server-side
 * so the secret only transits the proxy (never stored or logged) and lets the
 * SPA list/search certificates and revoke them.
 *
 * Endpoints used (see /api/v2/swagger/swagger.json):
 *   POST  /certificates/         list/search (GetCertificatesPayload filters)
 *   GET   /certificates/{id}/status
 *   PATCH /certificates/{id}     revoke  { reason, revocationDate?, issuerDN? }
 *
 * Transport-only: credentials are used to sign and then discarded.
 */

const https  = require('https')
const http   = require('http')
const crypto = require('crypto')
const dns    = require('dns').promises
const net    = require('net')
const { URL } = require('url')

const TIMEOUT = 30000

// ── SSRF guard (same policy as the SCEP client) ──────────────────────────────
function isPrivateIp(addr) {
  let ip = (addr || '').toLowerCase()
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    )
  }
  return (
    ip === '::1' || ip === '::' ||
    ip.startsWith('fc') || ip.startsWith('fd') ||
    ip.startsWith('fe8') || ip.startsWith('fe9') ||
    ip.startsWith('fea') || ip.startsWith('feb')
  )
}

async function resolvePinnedAddress(hostname) {
  let addrs
  if (net.isIP(hostname)) {
    addrs = [{ address: hostname, family: net.isIP(hostname) }]
  } else {
    addrs = await dns.lookup(hostname, { all: true })
  }
  if (!addrs || !addrs.length) throw new Error(`Could not resolve ${hostname}`)
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error(`Refusing to connect: ${hostname} resolves to a private/internal address (${a.address})`)
    }
  }
  return { address: addrs[0].address, family: addrs[0].family }
}

// ── HAWK 1.0 client signature (HMAC-SHA256) ──────────────────────────────────
function hawkPayloadHash(contentType, body) {
  const h = crypto.createHash('sha256')
  h.update('hawk.1.payload\n')
  h.update(`${(contentType || '').split(';')[0].trim().toLowerCase()}\n`)
  h.update(body || '')
  h.update('\n')
  return h.digest('base64')
}

function hawkHeader({ id, key, method, url, contentType, body }) {
  const u = new URL(url)
  const ts = Math.floor(Date.now() / 1000)
  const nonce = crypto.randomBytes(6).toString('hex')
  const port = u.port || (u.protocol === 'https:' ? '443' : '80')
  const resource = u.pathname + u.search

  let hash = ''
  if (body != null && body !== '') hash = hawkPayloadHash(contentType, body)

  const normalized =
    'hawk.1.header\n' +
    `${ts}\n` +
    `${nonce}\n` +
    `${method.toUpperCase()}\n` +
    `${resource}\n` +
    `${u.hostname.toLowerCase()}\n` +
    `${port}\n` +
    `${hash}\n` +
    `\n` // ext (empty)

  const mac = crypto.createHmac('sha256', key).update(normalized).digest('base64')

  let header = `Hawk id="${id}", ts="${ts}", nonce="${nonce}", `
  if (hash) header += `hash="${hash}", `
  header += `mac="${mac}"`
  return header
}

// Pin every connection to the pre-validated address. The custom lookup must
// honour options.all (newer Node requests all addresses → expects an array).
function pinnedLookup(pinned) {
  return (_hostname, options, cb) => {
    if (options && options.all) return cb(null, [{ address: pinned.address, family: pinned.family }])
    return cb(null, pinned.address, pinned.family)
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function request(url, { method, headers, body, insecureTLS, pinned }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'Accept-Encoding': 'identity', ...headers },
      rejectUnauthorized: !insecureTLS,
      ...(pinned ? { lookup: pinnedLookup(pinned) } : {}),
      ...(pinned && u.protocol === 'https:' ? { servername: u.hostname } : {}),
    }
    const req = lib.request(opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.setTimeout(TIMEOUT, () => { req.destroy(); reject(new Error('ZTPKI request timed out')) })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/**
 * Sign and forward a single ZTPKI API call.
 *
 * @param {object} o
 * @param {string} o.baseUrl   e.g. https://ztpki-staging.venafi.com/api/v2
 * @param {string} o.path      e.g. /certificates/  (must start with /certificates)
 * @param {string} o.method    GET | POST | PATCH
 * @param {object} [o.body]    JSON body for POST/PATCH
 * @param {string} o.hawkId
 * @param {string} o.hawkKey
 * @param {boolean}[o.insecureTLS]
 * @returns {Promise<{status:number, json:any, raw:string}>}
 */
async function call(o) {
  const base = o.baseUrl.replace(/\/+$/, '')
  const url = base + (o.path.startsWith('/') ? o.path : '/' + o.path)
  const u = new URL(url)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`Unsupported ZTPKI url scheme: ${u.protocol}`)
  }
  const pinned = await resolvePinnedAddress(u.hostname)

  const method = (o.method || 'GET').toUpperCase()
  const hasBody = o.body !== undefined && o.body !== null && method !== 'GET'
  const bodyStr = hasBody ? JSON.stringify(o.body) : null
  const contentType = 'application/json'

  const auth = hawkHeader({
    id: o.hawkId, key: o.hawkKey, method, url,
    contentType: hasBody ? contentType : null, body: bodyStr,
  })

  const headers = { Authorization: auth, Accept: 'application/json' }
  if (hasBody) {
    headers['Content-Type'] = contentType
    headers['Content-Length'] = Buffer.byteLength(bodyStr)
  }

  const res = await request(url, { method, headers, body: bodyStr, insecureTLS: !!o.insecureTLS, pinned })
  let json = null
  try { json = res.body ? JSON.parse(res.body) : null } catch { /* non-JSON body */ }
  return { status: res.status, json, raw: res.body }
}

module.exports = { call }
module.exports.__internals = { isPrivateIp, resolvePinnedAddress, hawkHeader, hawkPayloadHash }
