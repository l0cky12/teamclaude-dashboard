// What the proxy's traffic would cost at API list prices. Team Claude 1.1.22
// books tokens per account and splits cache tokens per quota bucket, not per
// model, so for Claude the model is inferred from the bucket: the Fable bucket
// is priced as Fable 5.1, everything else as Opus 5.5. Codex books everything in
// one bucket, so it is priced as a range: between the cheapest and the dearest
// model the account has served. A proxy carrying docs/upstream/'s patch reports
// tokens per model, and then every model is priced exactly.

// $ per million tokens.
export const PRICES = {
  // Anthropic API list prices as of 2026-09. Cache writes at the 5-minute rate (1.25x input).
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  // OpenAI standard tier, prompts up to 272K tokens, as of 2026-10. Team Claude
  // books Codex cache writes as input, so cacheWrite never applies there.
  'gpt-6-astra': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'gpt-6.1-sol': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'gpt-6-sol': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  'gpt-5.6-terra': { input: 2, output: 12, cacheWrite: 2.5, cacheRead: 0.2 },
  'gpt-5.6-sol': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.4 }, // promotional, through at least 2026-11-21
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheWrite: 0.25, cacheRead: 0.02 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheWrite: 1.75, cacheRead: 0.175 },
};
const BUCKET_MODEL = { unified7dFable: 'claude-fable-5-1' };
const DEFAULT_MODEL = 'claude-opus-5-5';
const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** List price for a model id as clients send it ("claude-opus-5-5[1m]", dated snapshots), or null. */
export function priceOf(model) {
  const k = String(model).replace(/\[\d+m\]$/, '').replace(/-\d{8}$/, '');
  return Object.hasOwn(PRICES, k) ? PRICES[k] : null;
}

/**
 * One account entry (a tick delta) split into token counts per model. A Codex
 * entry without a per-model split comes back as `codex`, carrying the models
 * the account has served as `candidates`.
 */
export function byModel(d, seen = null) {
  if (d.models) return d.models;
  if (d.input == null) return { [d.provider === 'codex' ? 'codex' : 'unknown']: { ...zero(), other: d.tokens || 0 } }; // logged before the split was recorded
  if (d.provider === 'codex') return { codex: { input: d.input, output: d.output, cacheRead: d.cacheRead, cacheWrite: d.cacheWrite, candidates: d.seen || seen || [] } };
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
  // model's share of cache tokens. Exact needs docs/upstream/'s patch in Team Claude.
  const cache = m => m.cacheRead + m.cacheWrite;
  const all = Object.values(out).reduce((n, m) => n + cache(m), 0);
  for (const [name, m] of Object.entries(out)) {
    const share = all ? cache(m) / all : name === DEFAULT_MODEL ? 1 : 0;
    m.input = (d.input || 0) * share; m.output = (d.output || 0) * share;
  }
  return out;
}

export const costOf = (t, model) => { const p = priceOf(model); return p ? KINDS.reduce((n, k) => n + (t[k] || 0) * p[k], 0) / 1e6 : null; };
const savingsOf = (t, model) => (t.cacheRead || 0) * (priceOf(model).input - priceOf(model).cacheRead) / 1e6;
const tokensOf = t => KINDS.reduce((n, k) => n + (t[k] || 0), 0) + (t.other || 0);

/**
 * Cost and tokens over ticks, by account, by model, by model within each
 * account, and in time bins of `binMs` starting at `since` (no bins when binMs
 * is 0). `cost` is the low end and `costHigh` the high end; they differ only
 * for Codex traffic priced as a range. Savings take the low end. `seen` maps
 * account names to the Codex models they serve now, for log rows recorded
 * before ticks carried their own.
 */
export function usageReport(ticks, { since = 0, until = Date.now(), binMs = 0, seen = {} } = {}) {
  const blank = () => ({ cost: 0, costHigh: 0, tokens: 0, requests: 0, ...zero(), savings: 0, unpriced: 0 });
  const range = () => ({ cost: 0, costHigh: 0 });
  const total = blank(), accounts = Object.create(null), models = Object.create(null);
  const bins = binMs ? Array.from({ length: Math.max(1, Math.ceil((until - since) / binMs)) }, (_, i) => ({ at: since + i * binMs, ...range(), accounts: Object.create(null) })) : [];
  for (const t of ticks) {
    if (t.at < since || t.at > until) continue;
    const bin = binMs ? bins[Math.min(bins.length - 1, Math.floor((t.at - since) / binMs))] : null;
    for (const [name, d] of Object.entries(t.accounts || {})) {
      const acc = accounts[name] ||= { ...blank(), provider: d.provider || 'anthropic', models: Object.create(null) };
      acc.requests += d.requests || 0; total.requests += d.requests || 0;
      for (const [model, tk] of Object.entries(byModel(d, Object.hasOwn(seen, name) ? seen[name] : null))) {
        const names = priceOf(model) ? [model] : (tk.candidates || []).filter(priceOf);
        const costs = names.map(m => costOf(tk, m)), tokens = tokensOf(tk);
        const mod = models[model] ||= { ...blank(), candidates: [] };
        const accMod = acc.models[model] ||= { ...blank(), candidates: [] };
        for (const o of [mod, accMod]) for (const m of tk.candidates || []) if (!o.candidates.includes(m)) o.candidates.push(m);
        for (const o of [total, acc, mod, accMod]) {
          o.tokens += tokens;
          for (const k of KINDS) o[k] += tk[k] || 0;
          if (!costs.length) { o.unpriced += tokens; continue; }
          o.cost += Math.min(...costs); o.costHigh += Math.max(...costs);
          o.savings += Math.min(...names.map(m => savingsOf(tk, m)));
        }
        if (!costs.length || !bin) continue;
        const b = bin.accounts[name] ||= range();
        for (const o of [bin, b]) { o.cost += Math.min(...costs); o.costHigh += Math.max(...costs); }
      }
    }
  }
  return { total, accounts, models, bins };
}
