window.__ModuleLoader__.load({
  id: "dsh-usage-pill",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = "usage-meter";
    /** Ambient list slot directly under the composer card. */
    const DOCK = "conversation.composer.dock";
    const STATE_URL = "/usage-meter/api/state";
    /** Backoff after a failed read; the host re-reads sources on its own cadence. */
    const RETRY_MS = 15_000;
    const STYLE_ID = "dsh-usage-pill-style";

    const zh = {
      "balance": "余额",
      "session": "本次",
      "limited": "已达上限",
      "meter.rolling": "5h",
      "meter.weekly": "周",
      "meter.monthly": "月",
      "cost.title": "按 DeepSeek 官方价格估算（每百万 token）",
      "source.title": "点击查看用量明细",
    };

    const en = {
      "balance": "Balance",
      "session": "Session",
      "limited": "limit reached",
      "meter.rolling": "5h",
      "meter.weekly": "Week",
      "meter.monthly": "Month",
      "cost.title": "Estimated at DeepSeek list prices (per 1M tokens)",
      "source.title": "Open the usage page",
    };

    /* Same 12/20 tertiary tier as the shipped stats pills, so the two rows read
       as one strip rather than two competing widgets. */
    const CSS = `
.dsum-root {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 12px;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.dsum-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  max-width: 100%;
  padding: 1px 8px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-variant-numeric: tabular-nums;
  line-height: inherit;
  white-space: nowrap;
  text-decoration: none;
}
a.dsum-pill { cursor: pointer; }
a.dsum-pill:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dsum-sep {
  color: var(--dsw-alias-separator-primary);
  margin: 0 2px;
}
.dsum-meter { color: var(--dsw-alias-label-tertiary); }
.dsum-full { color: var(--dsw-alias-label-warning, var(--dsw-alias-label-secondary)); }
`;

    const SYMBOLS = { CNY: "\u00a5", USD: "$" };

    const KNOWN_METERS = {
      rolling: "meter.rolling",
      weekly: "meter.weekly",
      monthly: "meter.monthly",
    };

    /**
     * Money for a pill: two decimals for balances, but enough precision to keep
     * a small per-session estimate from reading as zero.
     */
    function formatMoney(amount, currency, precise) {
      const symbol = SYMBOLS[currency] ?? `${currency} `;
      const value = Number(amount);
      if (!Number.isFinite(value)) return `${symbol}0.00`;
      const digits = precise && value > 0 && value < 1 ? 3 : 2;
      return symbol + value.toFixed(digits);
    }

    /** Token counts x the configured per-million prices. */
    function estimateCost(usage, pricing) {
      if (!usage || !pricing) return null;
      const input = usage.uncachedInputTokens ?? 0;
      const cacheRead = usage.cacheReadTokens ?? 0;
      const cacheWrite = usage.cacheWriteTokens ?? 0;
      const output = usage.outputTokens ?? 0;
      if (input + cacheRead + cacheWrite + output === 0) return null;
      const total = input * (pricing.input ?? 0)
        + cacheRead * (pricing.cacheRead ?? 0)
        + cacheWrite * (pricing.cacheWrite ?? pricing.input ?? 0)
        + output * (pricing.output ?? 0);
      return total / 1_000_000;
    }

    function meterLabel(meter, t) {
      const key = KNOWN_METERS[meter.key];
      if (key) return t(key);
      return meter.label ?? meter.key;
    }

    /** One pill's worth of text for a healthy source. */
    function describeSource(source, t) {
      const parts = [];
      for (const balance of source.balances ?? []) {
        parts.push(`${t("balance")} ${formatMoney(balance.total, balance.currency, false)}`);
      }
      for (const meter of source.meters ?? []) {
        const spend = `${meterLabel(meter, t)} ${Math.round(meter.percent)}%`;
        parts.push(meter.limited ? `${spend} ${t("limited")}` : spend);
      }
      return parts.join(" \u00b7 ");
    }

    function describeSourceTitle(source, t) {
      const lines = [source.label];
      for (const balance of source.balances ?? []) {
        lines.push(`${balance.currency} ${balance.total}`);
      }
      for (const meter of source.meters ?? []) {
        const reset = meter.resetsAt ? ` (${String(meter.resetsAt)})` : "";
        lines.push(`${meterLabel(meter, t)} ${Math.round(meter.percent)}%${reset}`);
      }
      if (source.link) lines.push(t("source.title"));
      return lines.join("\n");
    }

    async function readState(signal) {
      const response = await fetch(STATE_URL, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    }

    function useUsageState() {
      const [state, setState] = React.useState(null);
      const [failed, setFailed] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        let timer = 0;
        let controller = null;
        const tick = () => {
          controller = new AbortController();
          readState(controller.signal).then(next => {
            if (!alive) return;
            setState(next);
            setFailed(false);
            timer = window.setTimeout(tick, Math.max(5_000, next.refreshMs ?? RETRY_MS));
          }).catch(error => {
            if (!alive || error?.name === "AbortError") return;
            setFailed(true);
            timer = window.setTimeout(tick, RETRY_MS);
          });
        };
        tick();
        return () => {
          alive = false;
          window.clearTimeout(timer);
          controller?.abort();
        };
      }, []);
      return [state, failed];
    }

    function useStyles() {
      React.useEffect(() => {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.append(style);
      }, []);
    }

    /**
     * The dock row: one pill per healthy source plus the running session cost.
     * Returns nothing until something is worth saying, so the strip never shows
     * a placeholder that then jumps.
     */
    /**
     * Pure view: turn one host snapshot plus the session projection into the
     * dock row. Returns nothing until something is worth saying, so the strip
     * never shows a placeholder that then jumps.
     */
    function renderRow(snapshot, usage, t) {
      const sources = (snapshot?.sources ?? []).filter(source => source.status === "ok");
      const cost = estimateCost(usage, snapshot?.pricing);
      const nodes = [];

      for (const source of sources) {
        const text = describeSource(source, t);
        if (!text) continue;
        const title = describeSourceTitle(source, t);
        nodes.push(h(source.link ? "a" : "span", {
          key: source.id,
          className: "dsum-pill",
          href: source.link,
          target: source.link ? "_blank" : undefined,
          rel: source.link ? "noreferrer" : undefined,
          title,
        }, text));
      }

      if (cost !== null) {
        nodes.push(h("span", {
          key: "cost",
          className: "dsum-pill",
          title: t("cost.title"),
        }, `${t("session")} \u2248${formatMoney(cost, snapshot?.pricing?.currency ?? "CNY", true)}`));
      }

      if (nodes.length === 0) return null;

      const children = [];
      nodes.forEach((node, index) => {
        if (index > 0) children.push(h("span", { key: `sep-${index}`, className: "dsum-sep" }, "\u00b7"));
        children.push(node);
      });
      return h("div", { className: "dsum-root" }, children);
    }

    /** The dock occupant: polls the host route and renders one row. */
    function UsageDock(props) {
      const [state] = useUsageState();
      useStyles();
      const usage = props.useProjection ? props.useProjection("tokenUsage") : undefined;
      return renderRow(state, usage, props.t);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "usage-meter: dictionaries");
      ctx.slots.inject(DOCK, () => ctx.slots.register({
        name: DOCK,
        id: "usage-meter",
        order: 20,
        locale: NS,
      }, UsageDock));
    }

    module.exports = { name: "dsh-usage-pill", inject: ["slots", "locale"], apply };
    /* Exposed for the render test and for debugging a live row from the console. */
    module.exports.internal = { renderRow, formatMoney, estimateCost, describeSource };
    return module.exports;
  },
});
