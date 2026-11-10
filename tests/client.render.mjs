/**
 * Render test for the client half. The shipped file is the real artifact: it
 * self-registers into the DSH module loader, so the test provides that global,
 * hands the factory a working `require`, and drives the exported pure view.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { renderToStaticMarkup } from 'react-dom/server'

const requireFromHere = createRequire(import.meta.url)
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let plugin
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      assert.equal(id, 'dsh-usage-pill')
      plugin = factory(id => requireFromHere(id))
    },
  },
}
new Function(source)() // eslint-disable-line no-new-func -- the artifact is a browser-style script

assert.equal(plugin.name, 'dsh-usage-pill')
assert.deepEqual(plugin.inject, ['slots', 'locale'])

// --- apply(): registrations -------------------------------------------------
const calls = []
const ctx = {
  effect(fn, label) {
    calls.push(['effect', label])
    return fn()
  },
  locale: {
    register(ns, dicts) {
      calls.push(['locale', ns, Object.keys(dicts)])
      return () => {}
    },
  },
  slots: {
    inject(name, cb) {
      calls.push(['inject', name])
      return cb()
    },
    register(options) {
      calls.push(['register', options])
      return () => {}
    },
  },
}
plugin.apply(ctx)
// ctx.effect() runs its callback immediately, so the locale registration lands
// inside the effect call: 0=effect, 1=locale, 2=inject, 3=register.
assert.deepEqual(calls[0], ['effect', 'usage-meter: dictionaries'])
assert.deepEqual(calls[1], ['locale', 'usage-meter', ['zh', 'en']])
assert.deepEqual(calls[2], ['inject', 'conversation.composer.dock'])
assert.equal(calls[3][1].id, 'usage-meter')
assert.equal(calls[3][1].locale, 'usage-meter')

// --- renderRow() ------------------------------------------------------------
const zh = {
  balance: '余额',
  session: '本次',
  limited: '已达上限',
  'meter.rolling': '5h',
  'meter.weekly': '周',
  'meter.monthly': '月',
  'cost.title': 'cost',
  'source.title': 'source',
}
const t = key => zh[key] ?? key

const snapshot = {
  pricing: { currency: 'CNY', input: 2, output: 3, cacheRead: 0.2, cacheWrite: 2 },
  sources: [
    {
      id: 'deepseek',
      label: 'DeepSeek',
      status: 'ok',
      link: 'https://platform.deepseek.com/usage',
      balances: [{ currency: 'CNY', total: '42.5' }],
      meters: [],
    },
    {
      id: 'opencode-go',
      label: 'OpenCode Go',
      status: 'ok',
      meters: [
        { key: 'rolling', label: 'rolling', percent: 12.4, limited: false },
        { key: 'weekly', label: 'weekly', percent: 61, limited: false },
        { key: 'monthly', label: 'monthly', percent: 100, limited: true },
      ],
      balances: [],
    },
    { id: 'offline', label: 'Offline', status: 'error', error: 'boom', meters: [], balances: [] },
  ],
}
const usage = {
  uncachedInputTokens: 120_000,
  outputTokens: 8_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 0,
}

const markup = renderToStaticMarkup(plugin.internal.renderRow(snapshot, usage, t))
console.log(markup)

assert.match(markup, /余额 ¥42\.50/)
assert.match(markup, /5h 12%/)
assert.match(markup, /周 61%/)
assert.match(markup, /月 100% 已达上限/)
assert.match(markup, /本次 ≈¥0\.464/)
assert.doesNotMatch(markup, /Offline/)
assert.match(markup, /href="https:\/\/platform\.deepseek\.com\/usage"/)

// Cost math: 120k*2 + 8k*3 + 1M*0.2 = 240k + 24k + 200k = 464k / 1M = 0.464 -> ¥0.464
assert.equal(plugin.internal.estimateCost(usage, snapshot.pricing), 0.464)

// Nothing to say -> no row at all.
assert.equal(plugin.internal.renderRow({ sources: [] }, undefined, t), null)
assert.equal(plugin.internal.formatMoney(0.0042, 'CNY', true), '¥0.004')
assert.equal(plugin.internal.formatMoney(42.5, 'CNY', false), '¥42.50')

console.log('client render test: ok')
