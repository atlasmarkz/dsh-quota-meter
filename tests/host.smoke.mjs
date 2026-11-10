/**
 * Standalone smoke test for the host half: a fake Cordis context captures the
 * registered route, then we invoke the handler directly. Run with
 * `node --experimental-strip-types`-free plain Node (the file is plain JS).
 */
import { createServer } from 'node:http'

import { apply, inject, name } from '../lib/index.js'

const upstream = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  if (req.url?.startsWith('/go')) {
    res.end(JSON.stringify({
      usage: {
        rolling: { status: 'ok', percent: 32, resetsAt: '2026-11-10T18:00:00.000Z' },
        weekly: { status: 'ok', percent: 12.5, resetsAt: '2026-11-16T00:00:00.000Z' },
        monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-12-01T00:00:00.000Z' },
      },
    }))
    return
  }
  res.end(JSON.stringify({
    workspace: { usageURL: 'https://opencode.ai/go' },
    go: {
      rolling: { percent: 12.4, limited: false, resetsAt: '2026-11-10T20:00:00Z' },
      weekly: { percent: 61, limited: false },
      monthly: { percent: 100, limited: true },
    },
  }))
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const port = upstream.address().port

const routes = []
const ctx = {
  effect(fn, label) {
    const disposer = fn()
    console.log('effect:', label, typeof disposer)
    return disposer
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  get() {
    return undefined
  },
}

apply(ctx, {
  refreshMs: 60_000,
  sources: [
    { id: 'deepseek', kind: 'deepseek-balance', label: 'DeepSeek' },
    {
      id: 'opencode-go',
      kind: 'http-json',
      label: 'OpenCode Go',
      url: `http://127.0.0.1:${port}/usage`,
      meters: { rolling: 'go.rolling', weekly: 'go.weekly', monthly: 'go.monthly' },
      link: 'workspace.usageURL',
    },
    { id: 'go', kind: 'opencode-go', label: 'OpenCode Go', url: `http://127.0.0.1:${port}/go`, apiKey: 'test-key' },
    { id: 'broken', kind: 'http-json', label: 'Broken', url: `http://127.0.0.1:${port}/nope`, meters: {} },
  ],
})

console.log('plugin:', name, inject)
console.log('routes:', routes.map(route => `${route.kind} ${route.path}`))

function call(url) {
  return new Promise(resolve => {
    const res = {
      status: 0,
      headers: {},
      body: '',
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(body) {
        this.body = body ?? ''
        resolve(this)
      },
    }
    routes[0].handler({ url, method: 'GET' }, res)
  })
}

const first = await call('/usage-meter/api/state')
console.log('status:', first.status, first.headers['content-type'])
const payload = JSON.parse(first.body)
console.log(JSON.stringify(payload, null, 2))

const go = payload.sources.find(source => source.id === 'go')
console.log('go meters:', JSON.stringify(go?.meters))
if (go?.meters?.length !== 3) throw new Error('opencode-go should expose three meters')
if (go.meters[0].percent !== 32) throw new Error('rolling percent')
if (go.meters[2].limited !== true) throw new Error('rate-limited window must read as limited')
if (go.link !== 'https://opencode.ai/docs/console/go/') throw new Error('default plan link')

const second = await call('/usage-meter/api/state?force=1')
console.log('force status:', second.status, 'sources:', JSON.parse(second.body).sources.length)

upstream.close()
