/**
 * @mark_future_ai/dsh-quota-meter — host half.
 *
 * Polls a list of usage sources (provider balances, subscription plan meters,
 * any JSON usage endpoint) and serves the cached snapshot to the client half
 * over a same-origin route. The client half only renders; it never touches a
 * secret.
 *
 * Sources are read lazily: a request that finds a fresh cache entry answers
 * from memory, so the dock row's polling costs nothing upstream. Entries are
 * refreshed per source with a single in-flight read, which keeps several open
 * windows from multiplying the upstream calls.
 *
 * @module @mark_future_ai/dsh-quota-meter
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Defaults used when the mount row omits a field. */
const DEFAULT_REFRESH_MS = 60_000
const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_PRICING = {
  currency: 'CNY',
  input: 2,
  output: 3,
  cacheRead: 0.2,
  cacheWrite: 2,
}
const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
const OPENCODE_GO_PLAN_URL = 'https://opencode.ai/docs/console/go/'
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const STATE_PATH = '/usage-meter/api/state'
const ROUTE_NAME = 'usage-meter: state endpoint'

export const name = '@mark_future_ai/dsh-quota-meter'
export const inject = ['webServer']

/**
 * Mount the host half.
 * @param ctx - plugin context; `webServer` is the only hard requirement.
 * @param config - normalized lazily, so a bad source fails one pill instead of the plugin.
 */
export function apply(ctx, config) {
  const options = normalizeConfig(config)
  /** @type {Map<string, { at: number, entry: unknown, pending?: Promise<unknown> }>} */
  const cache = new Map()

  /**
   * Read every source, honoring the per-source cache.
   * @param force - bypass fresh entries (still coalesced with an in-flight read).
   */
  async function readAll(force) {
    return Promise.all(options.sources.map(source => readCached(source, force)))
  }

  function readCached(source, force) {
    const now = Date.now()
    const hit = cache.get(source.id)
    if (!force && hit) {
      if (hit.pending) return hit.pending
      if (now - hit.at < options.refreshMs) return Promise.resolve(hit.entry)
    }
    if (hit?.pending) return hit.pending
    const pending = readSource(ctx, source, options)
      .then(entry => {
        cache.set(source.id, { at: Date.now(), entry })
        return entry
      })
      .catch(error => {
        const entry = failed(source, error)
        cache.set(source.id, { at: Date.now(), entry })
        return entry
      })
    cache.set(source.id, { at: hit?.at ?? 0, entry: hit?.entry, pending })
    return pending
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? STATE_PATH, 'http://127.0.0.1')
        const sources = await readAll(url.searchParams.get('force') === '1')
        sendJson(res, 200, {
          version: 1,
          updatedAt: Date.now(),
          refreshMs: options.refreshMs,
          pricing: options.pricing,
          sources,
        })
      } catch (error) {
        sendJson(res, 500, { error: message(error) })
      }
    },
  }), ROUTE_NAME)
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Read one source, converting any failure into a rendered-as-unavailable entry
 * so one broken provider never blanks the row.
 */
async function readSource(ctx, source, options) {
  try {
    if (source.kind === 'deepseek-balance') return await readDeepSeekBalance(ctx, source, options)
    if (source.kind === 'opencode-go') return await readOpencodeGo(ctx, source, options)
    if (source.kind === 'http-json') return await readHttpJson(source, options)
    return { ...baseEntry(source), status: 'error', error: `unknown source kind "${String(source.kind)}"` }
  } catch (error) {
    return failed(source, error)
  }
}

/** Body shape of `GET https://api.deepseek.com/user/balance`. */
async function readDeepSeekBalance(ctx, source, options) {
  const key = await resolveApiKey(ctx, source)
  if (!key) {
    return {
      ...baseEntry(source),
      status: 'unconfigured',
      error: `no key in ${source.apiKeyEnv ?? 'DEEPSEEK_API_KEY'} or the credentials service`,
    }
  }
  const body = await getJson(source.url ?? DEEPSEEK_BALANCE_URL, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
  }, options)
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
  return {
    ...baseEntry(source),
    status: 'ok',
    available: body?.is_available !== false,
    link: source.link,
    balances: infos.map(info => ({
      currency: String(info?.currency ?? 'CNY'),
      total: String(info?.total_balance ?? '0'),
      granted: info?.granted_balance === undefined ? undefined : String(info.granted_balance),
      toppedUp: info?.topped_up_balance === undefined ? undefined : String(info.topped_up_balance),
    })),
    meters: [],
  }
}

/**
 * `GET https://opencode.ai/zen/go/v1/usage` — the OpenCode Go subscription
 * meters. Body: `{ usage: { rolling|weekly|monthly: { status, percent,
 * resetsAt } } }`; `status: "rate-limited"` is the provider's own word for a
 * capped window, so it beats inferring from the percentage.
 */
async function readOpencodeGo(ctx, source, options) {
  const key = await resolveApiKey(ctx, { ...source, apiKeyEnv: source.apiKeyEnv ?? 'OPENCODE_GO_API_KEY' })
  if (!key) {
    return {
      ...baseEntry(source),
      status: 'unconfigured',
      error: `no key in ${source.apiKeyEnv ?? 'OPENCODE_GO_API_KEY'}, the credentials service, or ~/.local/share/opencode/auth.json`,
    }
  }
  const body = await getJson(source.url ?? OPENCODE_GO_USAGE_URL, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
  }, options)
  const usage = body?.usage && typeof body.usage === 'object' ? body.usage : {}
  const meters = []
  for (const key of ['rolling', 'weekly', 'monthly']) {
    const window = usage[key]
    const percent = numberAt(window, 'percent')
    if (percent === undefined) continue
    meters.push({
      key,
      label: key,
      percent: Math.min(100, Math.max(0, percent)),
      limited: window?.status === 'rate-limited' || percent >= 100,
      resetsAt: typeof window?.resetsAt === 'string' ? window.resetsAt : undefined,
    })
  }
  if (meters.length === 0) throw new Error('usage endpoint answered without rolling/weekly/monthly meters')
  return {
    ...baseEntry(source),
    status: 'ok',
    link: source.link ?? OPENCODE_GO_PLAN_URL,
    plan: source.plan,
    meters,
    balances: [],
  }
}

/**
 * Map an arbitrary JSON usage payload with dot paths.
 *
 * `meters` is `{ <pillKey>: <basePath> | { percent, limited, resetsAt, label } }`;
 * each meter reads `<basePath>.percent` by default.
 */
async function readHttpJson(source, options) {
  const body = await getJson(source.url, {
    headers: expandHeaders(source.headers),
  }, options)
  const meters = []
  for (const [key, spec] of Object.entries(source.meters ?? {})) {
    const shape = typeof spec === 'string' ? { percent: `${spec}.percent` } : spec
    const percent = numberAt(body, shape.percent)
    if (percent === undefined) continue
    meters.push({
      key,
      label: shape.label ?? key,
      percent,
      limited: shape.limited ? Boolean(pathGet(body, shape.limited)) : percent >= 100,
      resetsAt: shape.resetsAt ? pathGet(body, shape.resetsAt) : undefined,
    })
  }
  const balances = []
  for (const [currency, spec] of Object.entries(source.balances ?? {})) {
    const total = numberAt(body, typeof spec === 'string' ? spec : spec.total)
    if (total === undefined) continue
    balances.push({ currency, total: String(total) })
  }
  return {
    ...baseEntry(source),
    status: 'ok',
    link: resolveLink(body, source.link),
    meters,
    balances,
  }
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function baseEntry(source) {
  return { id: source.id, label: source.label, kind: source.kind, link: source.link, meters: [], balances: [] }
}

function failed(source, error) {
  return { ...baseEntry(source), status: 'error', error: message(error) }
}

/** `$ENV:NAME` indirection keeps secrets out of the profile patch file. */
function expand(value) {
  const match = /^\$ENV:([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(value))
  if (!match) return String(value)
  return process.env[match[1]] ?? ''
}

function expandHeaders(headers) {
  const out = { accept: 'application/json' }
  for (const [key, value] of Object.entries(headers ?? {})) {
    const expanded = expand(value)
    if (expanded !== '') out[key] = expanded
  }
  return out
}

async function getJson(url, init, options) {
  if (!url) throw new Error('source is missing "url"')
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs) })
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`)
  return await response.json()
}

/**
 * Explicit config first, then the environment (the launcher usually exports
 * it), then the credential service — which is where the desktop app keeps a
 * key entered through Settings rather than a shell profile.
 */
async function resolveApiKey(ctx, source) {
  const ref = source.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
  if (source.apiKey) return String(source.apiKey)
  const env = process.env[ref]
  if (env) return env
  const stored = await readOpenCodeAuthKey(ref)
  if (stored) return stored
  try {
    const credentials = ctx.get?.('credentials')
    const resolved = await credentials?.resolve?.(ref)
    const value = resolved?.value ?? resolved?.secret
    if (typeof value === 'string' && value !== '') return value
  } catch {
    // A provider that refuses the reference just means "not configured here".
  }
  return undefined
}

/** `OPENCODE_*` refs map onto the provider ids OpenCode Desktop stores keys for. */
const OPENCODE_AUTH_FILES = ['.local/share/opencode/auth.json', '.config/opencode/auth.json']

async function readOpenCodeAuthKey(ref) {
  if (!/^OPENCODE/i.test(ref)) return undefined
  for (const relative of OPENCODE_AUTH_FILES) {
    try {
      const entry = JSON.parse(await readFile(join(homedir(), relative), 'utf8'))?.['opencode-go']
      const value = entry?.key ?? entry?.access
      if (typeof value === 'string' && value !== '') return value
    } catch {
      // Missing or unreadable: fall through to the next location.
    }
  }
  return undefined
}

function resolveLink(body, link) {
  if (!link) return undefined
  if (/^https?:\/\//.test(link)) return link
  const value = pathGet(body, link)
  return typeof value === 'string' ? value : undefined
}

function pathGet(root, path) {
  if (!path) return undefined
  let node = root
  for (const segment of String(path).split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[segment]
  }
  return node
}

function numberAt(root, path) {
  const value = pathGet(root, path)
  const number = typeof value === 'string' ? Number.parseFloat(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Fill in defaults without mutating the mount row's config object. */
function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const sources = Array.isArray(raw.sources) && raw.sources.length > 0
    ? raw.sources
    : [
        { id: 'deepseek', kind: 'deepseek-balance', label: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', link: 'https://platform.deepseek.com/usage' },
        { id: 'opencode-go', kind: 'opencode-go', label: 'OpenCode Go', apiKeyEnv: 'OPENCODE_GO_API_KEY' },
      ]
  return {
    refreshMs: positive(raw.refreshMs, DEFAULT_REFRESH_MS),
    timeoutMs: positive(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
    pricing: { ...DEFAULT_PRICING, ...(raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : {}) },
    sources: sources.map((source, index) => ({
      id: String(source?.id ?? `source-${index + 1}`),
      kind: String(source?.kind ?? 'deepseek-balance'),
      label: String(source?.label ?? source?.id ?? `source-${index + 1}`),
      ...source,
    })),
  }
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
