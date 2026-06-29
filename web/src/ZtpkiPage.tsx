import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ShieldX, Search, Loader, KeyRound, Eye, EyeOff, AlertTriangle,
  Ban, RefreshCw, X, Info, Clock,
} from 'lucide-react'

// ── Types (from ZTPKI swagger) ───────────────────────────────────────────────
interface CertItem {
  id: string
  commonName?: string
  serial?: string
  notBefore?: string
  notAfter?: string
  revocationStatus?: string
  SANs?: string[]
  policy?: { name?: string }
}
interface CertList { count?: number; items?: CertItem[] }

const REVOKE_STATES = ['VALID', 'PENDING', 'IN_PROCESS', 'REVOKED', 'FAILED', 'EXPIRED', 'RENEWED'] as const

// RFC 5280 CRLReason codes accepted by ZTPKI (2/6/8/9/10 are not allowed)
const REASONS = [
  { code: 1, key: 'key_compromise' },
  { code: 4, key: 'superseded' },
  { code: 3, key: 'affiliation_changed' },
  { code: 5, key: 'cessation' },
  { code: 0, key: 'unspecified' },
] as const

const DEFAULT_BASE = 'https://ztpki-staging.venafi.com/api/v2'

// ZTPKI's common_name filter is exact-match. To support wildcards (e.g.
// *.dominio.com) we fetch a broader page and match client-side. `*` → any run.
function wildcardToRegex(pattern: string): RegExp {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp('^' + esc + '$', 'i')
}
const WILDCARD_SCAN_LIMIT = 1000

function statusStyle(s?: string) {
  switch (s) {
    case 'VALID':   return 'text-spiffe bg-spiffe/15 border-spiffe/30'
    case 'REVOKED': return 'text-mi-red bg-mi-red/15 border-mi-red/30'
    case 'FAILED':  return 'text-mi-red bg-mi-red/15 border-mi-red/30'
    case 'PENDING':
    case 'IN_PROCESS': return 'text-mi-gold bg-mi-gold/15 border-mi-gold/30'
    case 'RENEWED': return 'text-mi-cyan bg-mi-cyan/15 border-mi-cyan/30'
    default:        return 'text-text-muted bg-bg-muted border-border' // EXPIRED / unknown
  }
}

function fmtDate(iso?: string) {
  if (!iso) return '—'
  try { return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: '2-digit' }).format(new Date(iso)) }
  catch { return iso }
}

export default function ZtpkiPage() {
  const { t } = useTranslation()

  // credentials
  const [hawkId, setHawkId] = useState('')
  const [hawkKey, setHawkKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE)

  // search filters
  const [cn, setCn] = useState('')
  const [serial, setSerial] = useState('')
  const [status, setStatus] = useState('')
  const [limit, setLimit] = useState(50)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [certs, setCerts] = useState<CertItem[] | null>(null)
  const [count, setCount] = useState(0)
  const [searchNote, setSearchNote] = useState<string | null>(null)

  // recently issued (last 24h)
  const [recent, setRecent] = useState<CertItem[] | null>(null)
  const [recentLoading, setRecentLoading] = useState(false)
  const [recentErr, setRecentErr] = useState<string | null>(null)

  // revoke modal
  const [target, setTarget] = useState<CertItem | null>(null)
  const [reason, setReason] = useState<number>(1)
  const [revoking, setRevoking] = useState(false)
  const [revokeErr, setRevokeErr] = useState<string | null>(null)

  const field = 'w-full bg-bg-muted border border-border rounded-lg px-3 py-2 text-sm text-text placeholder-text-muted focus:border-mi-cyan/60 focus:outline-none focus:ring-1 focus:ring-mi-cyan/20 transition-colors'
  const label = 'block text-xs font-semibold text-text-2 mb-1'

  async function ztpki(path: string, method: string, body?: unknown) {
    const res = await fetch('/api/ztpki', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hawkId: hawkId.trim(), hawkKey, baseUrl: baseUrl.trim(), path, method, body }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`)
    return data
  }

  async function runSearch(e?: React.FormEvent) {
    e?.preventDefault()
    if (!hawkId.trim() || !hawkKey) { setError(t('ztpki_page.need_creds')); return }
    setError(null); setLoading(true); setCerts(null); setSearchNote(null)
    try {
      const cnTerm = cn.trim()
      const wildcard = cnTerm.includes('*')
      // For wildcard CN we can't use the exact server filter — fetch a broader
      // page (still scoped by serial/status) and match the pattern client-side.
      const payload: Record<string, unknown> = {
        limit: wildcard ? WILDCARD_SCAN_LIMIT : (Number(limit) || 50),
        offset: 0,
      }
      if (cnTerm && !wildcard) payload.common_name = cnTerm
      if (serial.trim()) payload.serial = serial.trim()
      if (status) payload.status = status
      const data: CertList = await ztpki('/certificates/', 'POST', payload)
      let items = data.items || []
      if (wildcard) {
        const re = wildcardToRegex(cnTerm)
        const scanned = items.length
        items = items.filter(c => re.test(c.commonName || '') || (c.SANs || []).some(s => re.test(s)))
        setSearchNote(
          t('ztpki_page.wildcard_note', { matched: items.length, scanned }) +
          (scanned >= WILDCARD_SCAN_LIMIT ? ' ' + t('ztpki_page.wildcard_truncated') : '')
        )
      }
      setCerts(items)
      setCount(wildcard ? items.length : (data.count ?? items.length))
      loadRecent() // refresh the "issued in last 24h" panel with the same creds
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  async function loadRecent() {
    if (!hawkId.trim() || !hawkKey) { setRecentErr(t('ztpki_page.need_creds')); return }
    setRecentErr(null); setRecentLoading(true)
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const data: CertList = await ztpki('/certificates/', 'POST', { created_since: since, limit: 50 })
      const items = (data.items || [])
        .slice()
        .sort((a, b) => new Date(b.notBefore || 0).getTime() - new Date(a.notBefore || 0).getTime())
        .slice(0, 5)
      setRecent(items)
    } catch (err: unknown) {
      setRecentErr(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setRecentLoading(false)
    }
  }

  async function confirmRevoke() {
    if (!target) return
    setRevoking(true); setRevokeErr(null)
    try {
      await ztpki(`/certificates/${encodeURIComponent(target.id)}`, 'PATCH', { reason })
      // reflect the new status from the authoritative status endpoint
      let newStatus = 'REVOKED'
      try {
        const st = await ztpki(`/certificates/${encodeURIComponent(target.id)}/status`, 'GET')
        newStatus = st.revocationStatus || newStatus
      } catch { /* keep optimistic REVOKED */ }
      setCerts(prev => prev?.map(c => c.id === target.id ? { ...c, revocationStatus: newStatus } : c) ?? prev)
      setTarget(null)
    } catch (err: unknown) {
      setRevokeErr(err instanceof Error ? err.message : 'Revocation failed')
    } finally {
      setRevoking(false)
    }
  }

  const canRevoke = (c: CertItem) => !['REVOKED', 'EXPIRED'].includes(c.revocationStatus || '')

  return (
    <div className="max-w-5xl mx-auto px-4 py-12">
      {/* Hero */}
      <div className="text-center mb-8">
        <span className="inline-flex items-center text-xs font-semibold tracking-wide uppercase text-mi-red bg-mi-red/10 border border-mi-red/30 rounded-full px-3 py-1">
          <ShieldX size={11} className="mr-1.5" /> {t('ztpki_page.badge')}
        </span>
        <h1 className="text-4xl sm:text-5xl font-bold mt-4 text-text">{t('ztpki_page.title')}</h1>
        <p className="text-text-2 mt-3 max-w-2xl mx-auto">{t('ztpki_page.subtitle')}</p>
      </div>

      {/* Credentials */}
      <div className="bg-bg-card border border-border rounded-2xl p-6 mb-5">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-muted mb-3">
          <KeyRound size={14} /> {t('ztpki_page.credentials')}
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className={label}>{t('ztpki_page.hawk_id')}</label>
            <input className={field} value={hawkId} onChange={e => setHawkId(e.target.value)} placeholder="HAWK credential ID" autoComplete="off" />
          </div>
          <div>
            <label className={label}>{t('ztpki_page.hawk_secret')}</label>
            <div className="relative">
              <input className={field + ' pr-9'} type={showKey ? 'text' : 'password'} value={hawkKey}
                onChange={e => setHawkKey(e.target.value)} placeholder="HAWK secret" autoComplete="off" />
              <button type="button" onClick={() => setShowKey(s => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text">
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>
          <div className="sm:col-span-2">
            <label className={label}>{t('ztpki_page.base_url')}</label>
            <input className={field} value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={DEFAULT_BASE} />
          </div>
        </div>
        <p className="flex items-start gap-1.5 text-[11px] text-text-muted mt-3">
          <Info size={13} className="shrink-0 mt-0.5" /> {t('ztpki_page.creds_note')}
        </p>
      </div>

      {/* Search */}
      <form onSubmit={runSearch} className="bg-bg-card border border-border rounded-2xl p-6 mb-6">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-muted mb-3">
          <Search size={14} /> {t('ztpki_page.search')}
        </div>
        <div className="grid sm:grid-cols-4 gap-4">
          <div className="sm:col-span-2">
            <label className={label}>{t('ztpki_page.common_name')}</label>
            <input className={field} value={cn} onChange={e => setCn(e.target.value)} placeholder="host.example.com  ·  *.dominio.com" />
            <p className="text-[11px] text-text-muted mt-1">{t('ztpki_page.cn_hint')}</p>
          </div>
          <div>
            <label className={label}>{t('ztpki_page.serial')}</label>
            <input className={field} value={serial} onChange={e => setSerial(e.target.value)} placeholder="0A1B2C…" />
          </div>
          <div>
            <label className={label}>{t('ztpki_page.status')}</label>
            <select className={field} value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">{t('ztpki_page.status_any')}</option>
              {REVOKE_STATES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>{t('ztpki_page.limit')}</label>
            <input className={field} type="number" min={1} max={1000} value={limit}
              onChange={e => setLimit(Number(e.target.value))} />
          </div>
          <div className="sm:col-span-3 flex items-end">
            <button type="submit" disabled={loading}
              className="w-full flex items-center justify-center gap-2 bg-mi-cyan text-bg font-semibold rounded-lg px-4 py-2.5 hover:bg-mi-cyan/80 disabled:opacity-50 transition-colors">
              {loading ? <><Loader size={16} className="animate-spin" /> {t('ztpki_page.searching')}</>
                       : <><Search size={16} /> {t('ztpki_page.search_btn')}</>}
            </button>
          </div>
        </div>
      </form>

      {/* Error */}
      <AnimatePresence>
        {error && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="mb-6 flex items-start gap-3 rounded-xl border border-mi-red/40 bg-mi-red/10 p-4">
            <AlertTriangle size={20} className="text-mi-red shrink-0" />
            <div className="text-sm text-text-2 break-words">{error}</div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Results */}
      {certs && (
        <div className="bg-bg-card border border-border rounded-2xl overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <span className="text-sm text-text-2">
              {t('ztpki_page.found', { count })}
              {searchNote && <span className="text-text-muted"> · {searchNote}</span>}
            </span>
            <button onClick={() => runSearch()} className="text-text-muted hover:text-mi-cyan" title={t('ztpki_page.refresh')}>
              <RefreshCw size={15} />
            </button>
          </div>
          {certs.length === 0 ? (
            <div className="px-5 py-10 text-center text-text-muted text-sm">{t('ztpki_page.no_results')}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-bg-muted/50 text-left text-xs uppercase tracking-wide text-text-muted">
                    <th className="px-4 py-2.5 font-semibold">{t('ztpki_page.col_cn')}</th>
                    <th className="px-4 py-2.5 font-semibold">{t('ztpki_page.col_serial')}</th>
                    <th className="px-4 py-2.5 font-semibold">{t('ztpki_page.col_status')}</th>
                    <th className="px-4 py-2.5 font-semibold">{t('ztpki_page.col_expiry')}</th>
                    <th className="px-4 py-2.5 font-semibold">{t('ztpki_page.col_policy')}</th>
                    <th className="px-4 py-2.5 font-semibold text-right">{t('ztpki_page.col_action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {certs.map((c, i) => (
                    <tr key={c.id} className={`border-b border-border/50 ${i % 2 ? 'bg-bg' : 'bg-bg-card'}`}>
                      <td className="px-4 py-2.5 text-text font-medium">{c.commonName || '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-text-2 break-all max-w-[12rem]">{c.serial || '—'}</td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded border ${statusStyle(c.revocationStatus)}`}>
                          {c.revocationStatus || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-text-2">{fmtDate(c.notAfter)}</td>
                      <td className="px-4 py-2.5 text-text-2">{c.policy?.name || '—'}</td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          disabled={!canRevoke(c)}
                          onClick={() => { setTarget(c); setReason(1); setRevokeErr(null) }}
                          className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded border border-mi-red/40 text-mi-red hover:bg-mi-red/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                          <Ban size={13} /> {t('ztpki_page.revoke')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Recently issued (last 24h) */}
      <div className="bg-bg-card border border-border rounded-2xl overflow-hidden mt-6">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-text flex items-center gap-2">
              <Clock size={15} className="text-mi-cyan" /> {t('ztpki_page.recent_title')}
            </div>
            <div className="text-xs text-text-muted mt-0.5">{t('ztpki_page.recent_sub')}</div>
          </div>
          <button onClick={loadRecent} disabled={recentLoading}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-border text-text-2 hover:bg-bg-muted disabled:opacity-50 transition-colors shrink-0">
            {recentLoading ? <Loader size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {recentLoading ? t('ztpki_page.recent_loading') : t('ztpki_page.recent_load')}
          </button>
        </div>
        {recentErr ? (
          <div className="px-5 py-4 text-sm text-mi-red break-words">{recentErr}</div>
        ) : recent === null ? (
          <div className="px-5 py-8 text-center text-text-muted text-sm">{t('ztpki_page.recent_hint')}</div>
        ) : recent.length === 0 ? (
          <div className="px-5 py-8 text-center text-text-muted text-sm">{t('ztpki_page.recent_empty')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-bg-muted/50 text-left text-xs uppercase tracking-wide text-text-muted">
                  <th className="px-4 py-2.5 font-semibold">{t('ztpki_page.col_cn')}</th>
                  <th className="px-4 py-2.5 font-semibold">{t('ztpki_page.col_serial')}</th>
                  <th className="px-4 py-2.5 font-semibold">{t('ztpki_page.recent_issued')}</th>
                  <th className="px-4 py-2.5 font-semibold">{t('ztpki_page.col_status')}</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((c, i) => (
                  <tr key={c.id} className={`border-b border-border/50 ${i % 2 ? 'bg-bg' : 'bg-bg-card'}`}>
                    <td className="px-4 py-2.5 text-text font-medium">{c.commonName || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-text-2 break-all max-w-[12rem]">{c.serial || '—'}</td>
                    <td className="px-4 py-2.5 text-text-2">{fmtDate(c.notBefore)}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded border ${statusStyle(c.revocationStatus)}`}>
                        {c.revocationStatus || '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Revoke confirmation modal */}
      <AnimatePresence>
        {target && (
          <motion.div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => !revoking && setTarget(null)}>
            <motion.div onClick={e => e.stopPropagation()}
              initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-md bg-bg-card border border-border rounded-2xl p-6">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2 text-mi-red font-bold">
                  <ShieldX size={20} /> {t('ztpki_page.revoke_title')}
                </div>
                <button onClick={() => !revoking && setTarget(null)} className="text-text-muted hover:text-text"><X size={18} /></button>
              </div>

              <div className="rounded-lg bg-bg-muted border border-border p-3 text-sm space-y-1 mb-4">
                <div className="text-text font-medium">{target.commonName || target.id}</div>
                <div className="text-xs text-text-muted font-mono break-all">{target.serial}</div>
              </div>

              <label className={label}>{t('ztpki_page.reason')}</label>
              <select className={field} value={reason} onChange={e => setReason(Number(e.target.value))} disabled={revoking}>
                {REASONS.map(r => (
                  <option key={r.code} value={r.code}>{t(`ztpki_page.reason_${r.key}`)} ({r.code})</option>
                ))}
              </select>

              <div className="flex items-start gap-2 text-xs text-mi-gold bg-mi-gold/10 border border-mi-gold/30 rounded-lg p-3 mt-4">
                <AlertTriangle size={15} className="shrink-0 mt-0.5" /> {t('ztpki_page.revoke_warning')}
              </div>

              {revokeErr && (
                <div className="text-sm text-mi-red bg-mi-red/5 border border-mi-red/20 rounded-lg p-3 mt-3 break-words">{revokeErr}</div>
              )}

              <div className="flex gap-3 mt-5">
                <button onClick={() => setTarget(null)} disabled={revoking}
                  className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-semibold text-text-2 hover:bg-bg-muted transition-colors">
                  {t('ztpki_page.cancel')}
                </button>
                <button onClick={confirmRevoke} disabled={revoking}
                  className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-mi-red px-4 py-2.5 text-sm font-semibold text-white hover:bg-mi-red/85 disabled:opacity-50 transition-colors">
                  {revoking ? <><Loader size={15} className="animate-spin" /> {t('ztpki_page.revoking')}</>
                            : <><Ban size={15} /> {t('ztpki_page.confirm_revoke')}</>}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
