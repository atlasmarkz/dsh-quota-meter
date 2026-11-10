# dsh-quota-meter

Plan usage, account balance and running cost for **DeepSeek Harness**, shown as
one ambient row under the composer — right below the stock
`1 turns · 15.9K tok · Cache hit 0%` pills.

```
                余额 ¥42.50 · OpenCode Go 5h 32% · 周 62% · 月 100% 已达上限 · 本次 ≈¥0.46
```

Everything sits in the `conversation.composer.dock` slot, so it follows the
session: switch sessions and the cost pill switches with them.

## Install

```sh
dsh plugin --profile web add @mark_future_ai/dsh-quota-meter
```

…or install it from the plugin market inside DSH. The package is plain
JavaScript — no build step, no runtime dependencies. Restart DSH once after the
first install: the loader composes the plugin tree at boot, and a new row is not
hot-added.

## What it shows

| Pill | Comes from | Notes |
| --- | --- | --- |
| `余额 ¥42.50` | `deepseek-balance` → `GET https://api.deepseek.com/user/balance` | DeepSeek wallet balance, one per currency |
| `5h 32% · 周 62% · 月 100%` | `opencode-go` → `GET https://opencode.ai/zen/go/v1/usage` | Subscription windows; a `rate-limited` window reads `已达上限` |
| `本次 ≈¥0.46` | the session's `tokenUsage` projection × your price table | An **estimate**, not a bill |

A source that is not configured (no key) simply renders nothing, and a source
that fails keeps its last good value — the row never goes blank or blocks the
composer.

Any provider that answers JSON can be added with the generic `http-json` source
and dot-path meter mapping; nothing is hard-coded per provider.

## Keys

The host half resolves each source's key in this order:

1. `apiKey` in the source config (avoid — it ends up in the patch file)
2. the environment variable named by `apiKeyEnv` (`DEEPSEEK_API_KEY`, `OPENCODE_GO_API_KEY`)
3. `~/.local/share/opencode/auth.json` — the store OpenCode Desktop already keeps, for `OPENCODE_*` refs
4. the DSH credentials service, i.e. a key typed into Settings

The key is only ever used by the host process, only against the provider that
owns it. The browser half never sees a secret: it polls a same-origin route that
returns balances, percentages and reset times.

## Configuration

Defaults are built in (DeepSeek balance + OpenCode Go plan, DeepSeek list
prices), so a bare install already works. To change anything, override the same
plugin id from your profile's `cordis.patch.yml`:

```yaml
- id: usage-meter
  config:
    refreshMs: 30000
    pricing: { currency: CNY, input: 2, output: 3, cacheRead: 0.2, cacheWrite: 2 }
    sources:
      - { id: deepseek, kind: deepseek-balance, label: DeepSeek, apiKeyEnv: DEEPSEEK_API_KEY }
      - { id: opencode-go, kind: opencode-go, label: OpenCode Go, apiKeyEnv: OPENCODE_GO_API_KEY }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `refreshMs` | `60000` | Client poll interval; the host caches per source and coalesces in-flight reads |
| `timeoutMs` | `8000` | Per-request timeout |
| `pricing.currency` | `CNY` | `CNY` renders `¥`, `USD` renders `$` |
| `pricing.input` / `output` | `2` / `3` | Per **million** tokens |
| `pricing.cacheRead` / `cacheWrite` | `0.2` / `2` | Per million tokens |

Prices follow the DeepSeek API list price by default; override them for the model
you actually run — the cost pill is only as honest as that table.

### Sources

Every source is `{ id, kind, label, link?, apiKeyEnv?, apiKey?, url? }` plus
kind-specific fields. `link` may be a URL, or a dot path into the response body
(`workspace.usageURL`) when it comes from the endpoint itself.

- **`deepseek-balance`** — DeepSeek wallet balance. Responds with `balances[]`.
- **`opencode-go`** — `GET https://opencode.ai/zen/go/v1/usage` with
  `Authorization: Bearer <key>`; reads `usage.rolling|weekly|monthly`
  (`{ status, percent, resetsAt }`). Default link is the OpenCode Go plan page.
- **`http-json`** — anything else:

```yaml
- id: my-plan
  kind: http-json
  label: My Plan
  url: https://example.com/api/usage
  headers:
    authorization: "$ENV:MY_PLAN_TOKEN"   # keep secrets out of the patch file
  meters:
    rolling: { percent: quota.fiveHour.used_pct, limited: quota.fiveHour.blocked, resetsAt: quota.fiveHour.reset, label: 5h }
    weekly: quota.week.used_pct
  balances:
    USD: credits.usd
  link: account.billingUrl
```

A meter without an explicit `limited` path counts as limited at `percent >= 100`.

## Route

```
GET /usage-meter/api/state[?force=1]
→ { version, updatedAt, refreshMs, pricing, sources: [{ id, label, kind, status, meters[], balances[], link?, error? }] }
```

`status` is `ok`, `error` or `unconfigured`; `force=1` bypasses the host cache.
The route is same-origin and behind the harness's own session cookie, so it is
not exposed to the network.

## Files

```
lib/index.js      host half  — route, source readers, cache (ESM, no build)
lib/client.js     browser half — one dock row, polls the route (CJS factory artifact)
cordis.patch.yml  bundle patch `dsh plugin add` merges into the profile tree
tests/            node smoke tests for both halves
```

## Tests

```sh
npm install --no-save react@18 react-dom@18
node tests/host.smoke.mjs      # route + every source kind against a local server
node tests/client.render.mjs   # renders the artifact with react-dom/server
```

## License

MIT © atlasmarkz

---

## 中文

在 DSH 输入框下方加一行环境信息：**官方余额、订阅套餐用量（5 小时 / 周 / 月）、当前会话花费估算**。

- 原生状态药丸下方一行，跟着会话切换；未配置的源不显示，失败的源保留上一次的值，不会挡住输入框。
- **DeepSeek 官方**：`api.deepseek.com/user/balance`，按币种显示余额。
- **OpenCode Go 订阅**：`opencode.ai/zen/go/v1/usage`，三段配额，`rate-limited` 显示「已达上限」。
- **其它套餐**：用 `http-json` 源 + 点路径映射，任何返回 JSON 的配额接口都能接，不用改代码。
- 密钥只留在宿主进程里，浏览器端拿到的只是余额、百分比和重置时间。查找顺序：配置 → 环境变量 → OpenCode 的 `auth.json` → DSH 凭据服务。
- `本次 ≈` 是用 token 数 × 单价表算出的估算值，不是账单；默认按 DeepSeek 官方价，可在 `pricing` 里改成你实际在用的模型价格。

安装：`dsh plugin --profile web add @mark_future_ai/dsh-quota-meter`，首次安装后重启一次 DSH。
