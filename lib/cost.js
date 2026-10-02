// What the proxy's traffic would cost at Anthropic API list prices. Team Claude
// books tokens per account and splits cache tokens per quota bucket, not per
// model, so the model is inferred from the bucket: the Fable bucket is priced as
// Fable 5.1, everything else as Opus 5.5. Codex accounts are counted, not priced.

// $ per million tokens, API list prices as of 2026-09. Cache writes at the
// 5-minute rate (1.25x input).
export const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
};
const BUCKET_MODEL = { unified7dFable: 'claude-fable-5-1' };
const DEFAULT_MODEL = 'claude-opus-5-5';
const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** One account entry (a tick delta) split into token counts per model. */
export function byModel(d) {
  if (d.input == null) return { [d.provider === 'codex' ? 'codex' : 'unknown']: { ...zero(), other: d.tokens || 0 } }; // logged before the split was recorded
  if (d.provider === 'codex') return { codex: { input: d.input, output: d.output, cacheRead: d.cacheRead, cacheWrite: d.cacheWrite } };
  const out = {};
  const add = (m, k, n) => { (out[m] ||= zero())[k] += n; };
  let cacheRead = d.cacheRead || 0, cacheWrite = d.cacheWrite || 0;
  for (const [b, v] of Object.entries(d.buckets || {})) {
    const m = BUCKET_MODEL[b] || DEFAULT_MODEL;
    add(m, 'cacheRead', v.cacheRead); add(m, 'cacheWrite', v.cacheWrite);
    cacheRead -= v.cacheRead; cacheWrite -= v.cacheWrite;
  }
  add(DEFAULT_MODEL, 'cacheRead', Math.max(0, cacheRead)); add(DEFAULT_MODEL, 'cacheWrite', Math.max(0, cacheWrite));
  // ponytail: input/output are not split by bucket upstream, so they follow each
  // model's share of cache tokens. Exact needs a per-model counter in Team Claude.
  const cache = m => m.cacheRead + m.cacheWrite;
  const all = Object.values(out).reduce((n, m) => n + cache(m), 0);
  for (const [name, m] of Object.entries(out)) {
    const share = all ? cache(m) / all : name === DEFAULT_MODEL ? 1 : 0;
    m.input = (d.input || 0) * share; m.output = (d.output || 0) * share;
  }
  return out;
}

export const costOf = (t, model) => PRICES[model] ? KINDS.reduce((n, k) => n + (t[k] || 0) * PRICES[model][k], 0) / 1e6 : null;
const tokensOf = t => KINDS.reduce((n, k) => n + (t[k] || 0), 0) + (t.other || 0);

/**
 * Cost and tokens over ticks, by account, by model, and in time bins of `binMs`
 * starting at `since` (no bins when binMs is 0).
 */
export function usageReport(ticks, { since = 0, until = Date.now(), binMs = 0 } = {}) {
  const blank = () => ({ cost: 0, tokens: 0, requests: 0, ...zero(), savings: 0, unpriced: 0 });
  const total = blank(), accounts = Object.create(null), models = {};
  const bins = binMs ? Array.from({ length: Math.max(1, Math.ceil((until - since) / binMs)) }, (_, i) => ({ at: since + i * binMs, cost: 0, accounts: Object.create(null) })) : [];
  for (const t of ticks) {
    if (t.at < since || t.at > until) continue;
    const bin = binMs ? bins[Math.min(bins.length - 1, Math.floor((t.at - since) / binMs))] : null;
    for (const [name, d] of Object.entries(t.accounts || {})) {
      const acc = accounts[name] ||= { ...blank(), provider: d.provider || 'anthropic' };
      acc.requests += d.requests || 0; total.requests += d.requests || 0;
      for (const [model, tk] of Object.entries(byModel(d))) {
        const cost = costOf(tk, model), tokens = tokensOf(tk);
        const mod = models[model] ||= { cost: 0, tokens: 0, priced: cost != null };
        mod.tokens += tokens;
        for (const o of [total, acc]) {
          o.tokens += tokens;
          for (const k of KINDS) o[k] += tk[k];
          if (cost == null) { o.unpriced += tokens; continue; }
          o.cost += cost;
          o.savings += tk.cacheRead * (PRICES[model].input - PRICES[model].cacheRead) / 1e6;
        }
        if (cost == null) continue;
        mod.cost += cost;
        if (bin) { bin.cost += cost; bin.accounts[name] = (bin.accounts[name] || 0) + cost; }
      }
    }
  }
  return { total, accounts, models, bins };
}
