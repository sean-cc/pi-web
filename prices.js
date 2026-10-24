import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Prices are looked up by the endpoint a model is actually called through, not
// by the provider's name. Two providers pointing at api.deepseek.com share
// DeepSeek's official prices; a provider pointing at a proxy is priced from its
// own models.json entry, because only that proxy knows what it charges.
//
// Vendor prices are fetched for endpoints we can read automatically (DeepSeek's
// pricing page, OpenRouter's model API). Other endpoints keep the `cost` the
// user configured for them; the SDK's bundled price is the last fallback.

const DEEPSEEK_PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing';
const DEEPSEEK_CNY_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const BIGMODEL_PRICING_URL = 'https://docs.bigmodel.cn/cn/guide/start/pricing.md';
const ANTHROPIC_PRICING_URL = 'https://www.anthropic.com/pricing';
const HUGGINGFACE_MODELS_URL = 'https://router.huggingface.co/v1/models';
const MOONSHOT_PRICING_URL = 'https://platform.kimi.com/docs/pricing/chat';
const ALIYUN_MODELS_URL = 'https://help.aliyun.com/zh/model-studio/models';
const ALIYUN_PRICING_URL = 'https://help.aliyun.com/zh/model-studio/model-pricing';
const CACHE_FILE = process.env.PI_WEB_PRICES_FILE
  || path.join(os.homedir(), '.pi', 'agent', 'pi-web-prices.json');
const FETCH_TIMEOUT_MS = Number(process.env.PI_WEB_PRICES_TIMEOUT_MS) || 15_000;
const ENABLED = process.env.PI_WEB_PRICES !== 'off';
const CACHE_SCHEMA = 3;

let cache = emptyCache();
let refreshPromise = null;
let lastCheckedAt = null;
let lastError = null;
let lastSummary = null;

function emptyCache() {
  return { schema: CACHE_SCHEMA, updatedAt: null, endpoints: {} };
}

export function endpointKey(baseUrl) {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}


/**
 * Reprice one usage object with the given rates. Mirrors the SDK's
 * calculateCost(), including request-wide price tiers and the 2x input charge
 * for 1h cache writes.
 */
export function computeUsageCost(usage, rates) {
  if (!usage || !rates) return null;
  const input = Number(usage.input) || 0;
  const output = Number(usage.output) || 0;
  const cacheRead = Number(usage.cacheRead) || 0;
  const cacheWrite = Number(usage.cacheWrite) || 0;
  const inputTokens = input + cacheRead + cacheWrite;

  let applied = rates;
  let bestScore = -1;
  for (const tier of rates.tiers || []) {
    if (inputTokens <= (tier.inputTokensAbove || 0)) continue;
    if (tier.outputTokensAbove !== undefined && output < tier.outputTokensAbove) continue;
    // Prefer the most specific tier: higher input threshold first, then a
    // higher output threshold. GLM's tables use both dimensions.
    const score = (tier.inputTokensAbove || 0) * 1_000_000_000 + (tier.outputTokensAbove || 0);
    if (score > bestScore) {
      applied = tier;
      bestScore = score;
    }
  }

  const longWrite = Number(usage.cacheWrite1h) || 0;
  const shortWrite = Math.max(0, cacheWrite - longWrite);
  return (applied.input / 1_000_000) * input
    + (applied.output / 1_000_000) * output
    + (applied.cacheRead / 1_000_000) * cacheRead
    + ((applied.cacheWrite || 0) * shortWrite + applied.input * 2 * longWrite) / 1_000_000;
}

/** Pick peak/off-peak rates for the message timestamp. */
export function selectPriceRates(price, timestamp = null) {
  if (!price) return { rates: null, period: null };
  if (price.peak && price.offPeak) {
    const peak = price.peakRule === 'deepseek' ? isDeepSeekPeak(timestamp) : false;
    return {
      rates: peak ? price.peak : price.offPeak,
      period: peak ? 'peak' : 'offPeak',
    };
  }
  return { rates: price.rates || null, period: null };
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtml(fragment) {
  return decodeEntities(String(fragment)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse DeepSeek's official pricing page. The table exposes one column per
 * model and peak/off-peak rows for cache-hit input, cache-miss input and
 * output. Prices are USD per million tokens.
 */
export function parseDeepSeekPricing(html, source = DEEPSEEK_PRICING_URL) {
  const tables = [...String(html).matchAll(/<table[\s\S]*?<\/table>/gi)].map((match) => match[0]);
  const table = tables.find((candidate) => {
    const text = stripHtml(candidate);
    return /PRICING|价格/i.test(text) && /CACHE HIT|缓存命中/i.test(text);
  });
  if (!table) return null;

  const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((match) =>
    [...match[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)].map((cell) => stripHtml(cell[0])));
  const header = rows.find((row) => row.some((cell) => /^(MODEL|模型)$/i.test(cell)));
  if (!header) return null;
  const modelIds = header
    .filter((cell) => cell && !/^(MODEL|模型)$/i.test(cell))
    .map((cell) => cell.replace(/\(\d+\)/g, '').trim())
    .filter(Boolean);
  if (modelIds.length === 0) return null;

  let category = null;
  let currency = null;
  const prices = [];
  for (const row of rows) {
    const text = row.join(' ');
    if (/CACHE HIT|缓存命中/i.test(text)) category = 'cacheRead';
    else if (/CACHE MISS|缓存未命中/i.test(text)) category = 'input';
    else if (/OUTPUT TOKENS|输出/i.test(text)) category = 'output';
    if (!category) continue;

    const period = /OFF-PEAK|空闲时段/i.test(text)
      ? 'offPeak'
      : /PEAK|高峰时段/i.test(text) ? 'peak' : null;
    if (!period) continue;

    const dollars = [...text.matchAll(/\$\s*([\d.]+)/g)].map((match) => Number(match[1]));
    const yuan = [...text.matchAll(/([\d.]+)\s*元/g)].map((match) => Number(match[1]));
    const values = dollars.length > 0 ? dollars : yuan;
    if (values.length < modelIds.length) continue;
    const rowCurrency = dollars.length > 0 ? 'USD' : 'CNY';
    if (currency && currency !== rowCurrency) return null;
    currency = rowCurrency;
    prices.push({ category, period, values: values.slice(-modelIds.length) });
  }

  const models = {};
  modelIds.forEach((modelId, index) => {
    const peak = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const offPeak = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const price of prices) {
      (price.period === 'peak' ? peak : offPeak)[price.category] = price.values[index];
    }
    if (peak.input <= 0 || peak.output <= 0) return;
    models[modelId] = {
      currency: currency || 'USD',
      peak,
      offPeak,
      peakRule: 'deepseek',
      source,
    };
  });
  return models;
}

/**
 * DeepSeek peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday. Off-peak
 * is half price. Chinese public holidays are also off-peak but are not modelled
 * here; those requests are billed at the (higher) peak rate.
 */
export function isDeepSeekPeak(timestamp = null) {
  const date = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(date.getTime())) return true;
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function parseOpenRouterModels(payload) {
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const models = {};
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.pricing) continue;
    const input = Number(entry.pricing.prompt) * 1_000_000;
    const output = Number(entry.pricing.completion) * 1_000_000;
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    if (input < 0 || output < 0) continue;
    models[entry.id] = {
      currency: 'USD',
      rates: {
        input,
        output,
        cacheRead: Math.max(0, Number(entry.pricing.input_cache_read) || 0) * 1_000_000,
        cacheWrite: Math.max(0, Number(entry.pricing.input_cache_write) || 0) * 1_000_000,
      },
      source: OPENROUTER_MODELS_URL,
    };
  }
  return models;
}

// ── BigModel / Zhipu (GLM) ────────────────────────────────────────────────
// The official pricing docs are published as Markdown, which is far more stable
// than the SPA pricing page. Prices are CNY per million tokens; some models
// have rows split by input length and/or output length.

function markdownCells(line) {
  const trimmed = String(line).trim().replace(/^>\s*/, '');
  if (!trimmed.startsWith('|')) return null;
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function parseCnyPrice(cell) {
  if (!cell) return null;
  if (cell.includes('免费')) return 0;
  const match = cell.match(/-?\d+(?:,\d{3})*(?:\.\d+)?/);
  return match ? Number(match[0].replace(/,/g, '')) : null;
}

function parseTokenCount(number, unit) {
  const value = Number(number);
  if (!Number.isFinite(value)) return 0;
  const suffix = String(unit || '').toUpperCase();
  if (suffix === 'M') return Math.round(value * 1_000_000);
  if (suffix === 'B') return Math.round(value * 1_000_000_000);
  if (suffix === 'K') return Math.round(value * 1_000);
  return Math.round(value);
}

function parseBigModelTier(context) {
  const text = String(context || '');
  const inputGe = text.match(/输入(?:长度)?\s*≥\s*([\d.]+)\s*([KMB])?/i);
  const inputRange = text.match(/输入(?:长度)?\s*\\?\[\s*([\d.]+)\s*([KMB])?/i);
  const outputGe = text.match(/输出\s*≥\s*([\d.]+)\s*([KMB])?/i);
  const outputRange = text.match(/输出\s*\\?\[\s*([\d.]+)\s*([KMB])?/i);
  return {
    inputTokensAbove: inputGe
      ? parseTokenCount(inputGe[1], inputGe[2])
      : inputRange ? parseTokenCount(inputRange[1], inputRange[2]) : 0,
    outputTokensAbove: outputGe
      ? parseTokenCount(outputGe[1], outputGe[2])
      : outputRange ? parseTokenCount(outputRange[1], outputRange[2]) : undefined,
  };
}

export function parseBigModelPricing(markdown) {
  const models = {};
  let header = null;
  for (const line of String(markdown).split(/\r?\n/)) {
    const cells = markdownCells(line);
    if (!cells) {
      header = null;
      continue;
    }
    if (cells.some((cell) => cell.includes('模型名称'))) {
      const inputCol = cells.findIndex((cell) => cell.includes('输入单价'));
      const outputCol = cells.findIndex((cell) => cell.includes('输出单价'));
      if (inputCol < 0 || outputCol < 0) {
        header = null;
        continue;
      }
      header = {
        inputCol,
        outputCol,
        cacheReadCol: cells.findIndex((cell) => cell.includes('缓存命中')),
        contextCol: cells.findIndex((cell) => cell.includes('上下文')),
      };
      continue;
    }
    if (!header) continue;
    if (cells.every((cell) => /^:?-+:?$/.test(cell) || cell === '')) continue;

    const modelName = cells[0].replace(/[*`]/g, '').replace(/<[^>]+>/g, '').trim();
    if (!modelName || /模型名称/.test(modelName)) continue;
    const input = parseCnyPrice(cells[header.inputCol]);
    const output = parseCnyPrice(cells[header.outputCol]);
    if (input === null || output === null) continue;
    const cacheRead = header.cacheReadCol >= 0
      ? parseCnyPrice(cells[header.cacheReadCol])
      : 0;
    const tier = parseBigModelTier(header.contextCol >= 0 ? cells[header.contextCol] : '');

    const modelId = modelName.toLowerCase();
    const entry = models[modelId] || { base: null, tiers: [] };
    const rates = { input, output, cacheRead: cacheRead ?? 0, cacheWrite: 0 };
    if (tier.inputTokensAbove === 0 && (tier.outputTokensAbove === undefined || tier.outputTokensAbove === 0)) {
      entry.base = rates;
    } else {
      entry.tiers.push({
        inputTokensAbove: tier.inputTokensAbove,
        ...(tier.outputTokensAbove !== undefined ? { outputTokensAbove: tier.outputTokensAbove } : {}),
        ...rates,
      });
    }
    models[modelId] = entry;
  }

  const result = {};
  for (const [id, entry] of Object.entries(models)) {
    if (!entry.base && entry.tiers.length === 0) continue;
    const rates = entry.base
      ? { ...entry.base }
      : (() => {
        const fallback = { ...entry.tiers[0] };
        delete fallback.inputTokensAbove;
        delete fallback.outputTokensAbove;
        return fallback;
      })();
    if (entry.tiers.length > 0) rates.tiers = entry.tiers;
    result[id] = { currency: 'CNY', rates, source: BIGMODEL_PRICING_URL };
  }
  return result;
}


export function parseAliyunConsolidatedPricing(html, modelId) {
  const text = stripHtml(html).replace(/\s+/g, ' ');
  const beijing = text.search(/华北\s*2\s*（北京）/);
  if (beijing < 0) return null;
  const section = text.slice(beijing);
  const index = section.indexOf(modelId);
  if (index < 0) return null;
  const snippet = section.slice(index, index + 400);
  const values = [...snippet.matchAll(/([\d.]+)\s*元/g)].map((m) => Number(m[1]));
  if (values.length < 2) return null;
  return {
    currency: 'CNY',
    rates: {
      input: values[0],
      output: values.length >= 3 ? values[2] : values[1],
      cacheRead: values.length >= 3 ? values[1] : 0,
      cacheWrite: 0,
    },
  };
}

// ── Anthropic (USD) ───────────────────────────────────────────────────────
// The public pricing page is a Next.js app, but it server-renders the API
// prices as text. Parse the model blocks instead of relying on the docs site,
// which is region-restricted.
export function parseAnthropicPricing(html) {
  const text = stripHtml(html).replace(/\s+/g, ' ');
  const headings = [...text.matchAll(/(Fable|Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)?)\b/g)]
    .map((match) => ({ name: match[1], version: match[2], index: match.index }));
  const models = {};
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const block = text.slice(heading.index, headings[i + 1]?.index ?? text.length);
    if (!/Prompt caching/.test(block)) continue;

    const reads = [...block.matchAll(/Read\s+\$([\d.]+)\s*\/\s*MTok/g)].map((m) => Number(m[1]));
    const writes = [...block.matchAll(/Write\s+\$([\d.]+)\s*\/\s*MTok/g)].map((m) => Number(m[1]));
    const inputs = [...block.matchAll(/Input[^$]*\$([\d.]+)\s*\/\s*MTok/g)].map((m) => Number(m[1]));
    const outputs = [...block.matchAll(/Output[^$]*\$([\d.]+)\s*\/\s*MTok/g)].map((m) => Number(m[1]));
    if (!inputs.length || !outputs.length) continue;

    const id = `claude-${heading.name.toLowerCase()}-${heading.version.replace(/\./g, '-')}`;
    const rates = {
      input: inputs[0],
      output: outputs[0],
      cacheRead: reads[0] || 0,
      cacheWrite: writes[0] || 0,
    };
    // Haiku 5.5 publishes two prompt-size tiers. The second input/output
    // price follows the "> 100K tokens" label without repeating "Input"/"Output".
    if (/>\s*100K tokens/.test(block)) {
      const tierCache = block.match(/>\s*100K tokens\s+Read\s*\$([\d.]+)\s*\/\s*MTok\s+Write\s*\$([\d.]+)/);
      const tierInput = block.match(/Input[^]*?>\s*100K tokens\s*\$([\d.]+)/);
      const tierOutput = block.match(/Output[^]*?>\s*100K tokens\s*\$([\d.]+)/);
      if (tierCache && tierInput && tierOutput) {
        rates.tiers = [{
          inputTokensAbove: 100000,
          input: Number(tierInput[1]),
          output: Number(tierOutput[1]),
          cacheRead: Number(tierCache[1]),
          cacheWrite: Number(tierCache[2]),
        }];
      }
    }
    if (!models[id]) models[id] = { currency: 'USD', rates, source: ANTHROPIC_PRICING_URL };
  }
  return models;
}

// ── HuggingFace Router (USD) ──────────────────────────────────────────────
// Router pricing is per million tokens. A model can be served by several
// providers at different prices; use the first live provider, which is the
// router's default order. The actual route can differ.
export function parseHuggingFacePricing(payload) {
  const models = {};
  for (const entry of payload?.data || []) {
    if (!entry || typeof entry.id !== 'string') continue;
    const live = (entry.providers || []).filter((provider) =>
      provider?.status === 'live'
      && provider.pricing
      && Number.isFinite(Number(provider.pricing.input))
      && Number.isFinite(Number(provider.pricing.output)));
    if (live.length === 0) continue;
    const provider = live[0];
    models[entry.id] = {
      currency: 'USD',
      rates: {
        input: Number(provider.pricing.input),
        output: Number(provider.pricing.output),
        cacheRead: Number(provider.pricing.cache_read) || 0,
        cacheWrite: Number(provider.pricing.cache_write) || 0,
      },
      source: `${HUGGINGFACE_MODELS_URL} (${provider.provider})`,
    };
  }
  return models;
}

// ── Moonshot / Kimi CN (CNY) ──────────────────────────────────────────────
// The pricing page is a Mintlify app that renders its tables as RSC _jsx()
// calls. The rows still contain stable model ids and ¥/MTok strings.
export function parseMoonshotPricing(html) {
  const models = {};
  const entryRe = /children:`([a-z0-9][a-z0-9.\-]*)`\}\)((?:,`[^`]*`)+)/g;
  for (const match of String(html).matchAll(entryRe)) {
    const id = match[1];
    if (models[id]) continue;
    const prices = [...match[2].matchAll(/¥\s*([\d.]+)\s*\/\s*MTok/g)].map((m) => Number(m[1]));
    if (prices.length < 3) continue;
    models[id] = {
      currency: 'CNY',
      rates: {
        input: prices[0],
        output: prices[1],
        cacheRead: prices[2],
        cacheWrite: prices.length >= 4 ? prices[3] : 0,
      },
      source: MOONSHOT_PRICING_URL,
    };
  }
  return models;
}

// ── Aliyun Model Studio / DashScope (CNY) ─────────────────────────────────
// Each model has its own docs page with a "模型价格" table. Use the first
// region table (华北 2 / Beijing) for dashscope.aliyuncs.com.
export function parseAliyunPricing(html) {
  const text = stripHtml(html).replace(/\s+/g, ' ');
  const priceIndex = text.indexOf('模型价格');
  if (priceIndex < 0) return null;
  let section = text.slice(priceIndex);
  const beijing = section.search(/华北\s*2\s*（北京）/);
  if (beijing >= 0) section = section.slice(beijing);
  const input = section.match(/输入\s+([\d.]+)\s+每百万 tokens/);
  const output = section.match(/输出\s+([\d.]+)\s+每百万 tokens/);
  if (!input || !output) return null;
  const cacheRead = section.match(/输入（缓存命中）\s+([\d.]+)\s+每百万 tokens/);
  const cacheWrite = section.match(/显式缓存创建\s+([\d.]+)\s+每百万 tokens/);
  return {
    currency: 'CNY',
    rates: {
      input: Number(input[1]),
      output: Number(output[1]),
      cacheRead: Number(cacheRead?.[1]) || 0,
      cacheWrite: Number(cacheWrite?.[1]) || 0,
    },
  };
}

/** A dated model id also matches its undated catalog entry. */
export function modelIdCandidates(modelId) {
  if (!modelId) return [];
  const candidates = [modelId];
  const undated = String(modelId).replace(/-\d{8}$/, '');
  if (undated !== modelId) candidates.push(undated);
  return candidates;
}

/**
 * Cost from the prices cached for this endpoint, or null when the endpoint has
 * no official price. Peak/off-peak prices are selected from the message time.
 */
export function resolveUsageCost(usage, endpoint, modelIds, timestamp = null) {
  if (!usage || !endpoint) return null;
  const entry = cache.endpoints[endpoint];
  if (!entry?.models) return null;
  const ids = Array.isArray(modelIds) ? modelIds : [modelIds];
  const candidates = [];
  for (const modelId of ids) {
    for (const candidate of modelIdCandidates(modelId)) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  for (const modelId of candidates) {
    const price = entry.models[modelId];
    if (!price) continue;
    const selected = selectPriceRates(price, timestamp);
    if (!selected.rates) continue;
    const cost = computeUsageCost(usage, selected.rates);
    if (cost === null) continue;
    return {
      cost,
      currency: price.currency || 'USD',
      source: price.source || entry.source || endpoint,
      period: selected.period,
    };
  }
  return null;
}

export function loadPriceCache() {
  if (!ENABLED) return getPriceStatus();
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (raw && raw.schema === CACHE_SCHEMA && raw.endpoints && typeof raw.endpoints === 'object') {
      cache = { schema: CACHE_SCHEMA, updatedAt: raw.updatedAt || null, endpoints: raw.endpoints };
    }
  } catch {
    // No cache yet, or an unreadable/stale file: use the local/SDK prices.
  }
  return getPriceStatus();
}

function savePriceCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CACHE_FILE);
  } catch (err) {
    console.warn(`[prices] could not save ${CACHE_FILE}: ${err.message}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Vendor endpoints occasionally answer slowly. Retry network errors and 5xx
// once; a second failure keeps whatever prices are already cached.
async function fetchWithRetry(url, accept) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept, 'User-Agent': `pi-web (${process.version})` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`);
      } else {
        return response;
      }
    } catch (err) {
      lastError = err;
    }
    if (attempt === 0) await sleep(800);
  }
  throw lastError || new Error('request failed');
}

export function hasPriceAdapter(endpoint) {
  return adapterFor(endpoint) !== null;
}

function adapterFor(endpoint) {
  if (endpoint === 'deepseek.com' || endpoint.endsWith('.deepseek.com')) return 'deepseek';
  if (endpoint === 'openrouter.ai' || endpoint.endsWith('.openrouter.ai')) return 'openrouter';
  if (endpoint === 'bigmodel.cn' || endpoint.endsWith('.bigmodel.cn')) return 'bigmodel';
  if (endpoint === 'api.anthropic.com') return 'anthropic';
  if (endpoint.endsWith('huggingface.co')) return 'huggingface';
  if (endpoint === 'api.moonshot.cn') return 'moonshot';
  if (endpoint.startsWith('dashscope') && endpoint.endsWith('.aliyuncs.com')) return 'aliyun';
  return null;
}

function prefersCny() {
  const override = (process.env.PI_WEB_PRICE_CURRENCY || '').toUpperCase();
  if (override === 'CNY' || override === 'USD') return override === 'CNY';
  const locale = process.env.LC_ALL || process.env.LC_MONETARY || process.env.LANG
    || Intl.DateTimeFormat().resolvedOptions().locale || '';
  return locale.toLowerCase().startsWith('zh');
}

async function fetchDeepSeekPrices() {
  const useCny = prefersCny();
  const url = useCny ? DEEPSEEK_CNY_PRICING_URL : DEEPSEEK_PRICING_URL;
  const load = async (target) => {
    const response = await fetchWithRetry(target, 'text/html');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseDeepSeekPricing(await response.text(), target);
  };

  let models = null;
  try {
    models = await load(url);
  } catch (err) {
    if (!useCny) throw err;
    // The Chinese page is preferred for a zh locale; fall back to the USD page.
    models = await load(DEEPSEEK_PRICING_URL);
  }
  if (!models || Object.keys(models).length === 0) throw new Error('could not parse the pricing table');
  return models;
}

async function fetchOpenRouterPrices() {
  const response = await fetchWithRetry(OPENROUTER_MODELS_URL, 'application/json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const models = parseOpenRouterModels(await response.json());
  if (Object.keys(models).length === 0) throw new Error('empty model list');
  return models;
}

async function fetchBigModelPrices() {
  const response = await fetchWithRetry(BIGMODEL_PRICING_URL, 'text/markdown, text/plain, */*');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const models = parseBigModelPricing(await response.text());
  if (Object.keys(models).length === 0) throw new Error('could not parse the pricing tables');
  return models;
}

/**
 * New vendor prices replace matching models. A model that the latest vendor
 * list no longer mentions keeps its previous official price, so a failed or
 * partial catalog never silently falls back to SDK prices.
 */
export function mergeModelPrices(previous, next) {
  return { ...(previous || {}), ...(next || {}) };
}

async function fetchAnthropicPrices() {
  const response = await fetchWithRetry(ANTHROPIC_PRICING_URL, 'text/html');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const models = parseAnthropicPricing(await response.text());
  if (Object.keys(models).length === 0) throw new Error('could not parse the pricing page');
  return models;
}

async function fetchHuggingFacePrices() {
  const response = await fetchWithRetry(HUGGINGFACE_MODELS_URL, 'application/json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const models = parseHuggingFacePricing(await response.json());
  if (Object.keys(models).length === 0) throw new Error('empty model list');
  return models;
}

async function fetchMoonshotPrices() {
  const response = await fetchWithRetry(MOONSHOT_PRICING_URL, 'text/html');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const models = parseMoonshotPricing(await response.text());
  if (Object.keys(models).length === 0) throw new Error('could not parse the pricing page');
  return models;
}

async function fetchAliyunPrices(modelIds) {
  const ids = [...new Set((modelIds || []).filter(Boolean))];
  let consolidatedPromise = null;
  const getConsolidated = () => {
    if (!consolidatedPromise) {
      consolidatedPromise = (async () => {
        const response = await fetchWithRetry(ALIYUN_PRICING_URL, 'text/html');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })();
    }
    return consolidatedPromise;
  };

  const results = await Promise.allSettled(ids.map(async (modelId) => {
    const url = `https://help.aliyun.com/zh/model-studio/${String(modelId).replace(/\./g, '-')}`;
    const response = await fetchWithRetry(url, 'text/html');
    if (!response.ok) throw new Error(`${modelId}: HTTP ${response.status}`);
    let parsed = parseAliyunPricing(await response.text());
    let source = url;
    if (!parsed) {
      // Some model pages just link to the consolidated price table.
      try {
        parsed = parseAliyunConsolidatedPricing(await getConsolidated(), modelId);
        if (parsed) source = ALIYUN_PRICING_URL;
      } catch {}
    }
    if (!parsed) throw new Error(`${modelId}: no price table`);
    return [modelId, { ...parsed, source }];
  }));
  const models = {};
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const [id, price] = result.value;
      models[id] = price;
    }
  }
  if (Object.keys(models).length === 0) throw new Error('could not parse any Aliyun model page');
  return models;
}

async function refreshEndpoint(endpoint, modelIds = []) {
  const adapter = adapterFor(endpoint);
  if (!adapter) return null;

  const previous = cache.endpoints[endpoint];
  const merge = (adapterName, fetched, source) => {
    const models = previous?.adapter === adapterName
      ? mergeModelPrices(previous.models, fetched)
      : fetched;
    cache.endpoints[endpoint] = {
      adapter: adapterName,
      source,
      checkedAt: Date.now(),
      models,
    };
    return Object.keys(models).length;
  };

  if (adapter === 'deepseek') {
    const fetched = await fetchDeepSeekPrices();
    const source = Object.values(fetched).find((price) => price?.source)?.source || DEEPSEEK_PRICING_URL;
    return merge('deepseek.com', fetched, source);
  }

  if (adapter === 'bigmodel') {
    return merge('bigmodel.cn', await fetchBigModelPrices(), BIGMODEL_PRICING_URL);
  }

  if (adapter === 'anthropic') {
    const fetched = await fetchAnthropicPrices();
    return merge('anthropic.com', fetched, ANTHROPIC_PRICING_URL);
  }

  if (adapter === 'huggingface') {
    const fetched = await fetchHuggingFacePrices();
    return merge('huggingface.co', fetched, HUGGINGFACE_MODELS_URL);
  }

  if (adapter === 'moonshot') {
    const fetched = await fetchMoonshotPrices();
    return merge('kimi.com', fetched, MOONSHOT_PRICING_URL);
  }

  if (adapter === 'aliyun') {
    const fetched = await fetchAliyunPrices(modelIds);
    return merge('aliyun.com', fetched, ALIYUN_MODELS_URL);
  }

  return merge('openrouter.ai', await fetchOpenRouterPrices(), OPENROUTER_MODELS_URL);
}

/**
 * Refresh prices for the endpoints the configured models actually use. Only
 * endpoints with a known vendor adapter are fetched; proxy endpoints keep the
 * cost configured in models.json. Best-effort and non-blocking.
 */
export async function refreshOfficialPrices(endpoints) {
  if (!ENABLED) return getPriceStatus();
  const entries = endpoints instanceof Map
    ? [...endpoints.entries()]
    : Array.isArray(endpoints)
      ? endpoints.map((endpoint) => [endpoint, []])
      : Object.entries(endpoints || {});
  const targets = entries
    .map(([endpoint, modelIds]) => [String(endpoint), [...(modelIds || [])]])
    .filter(([endpoint]) => adapterFor(endpoint));
  if (targets.length === 0) return getPriceStatus();
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    lastCheckedAt = new Date().toISOString();
    // Persist each endpoint as soon as it succeeds, so one slow vendor does not
    // delay prices that are already fresh.
    const results = await Promise.allSettled(targets.map(async ([endpoint, modelIds]) => {
      const count = await refreshEndpoint(endpoint, modelIds);
      cache.updatedAt = new Date().toISOString();
      savePriceCache();
      return count;
    }));
    const failures = results
      .map((result) => (result.status === 'rejected' ? String(result.reason?.message || result.reason) : null))
      .filter(Boolean);
    lastError = failures.length > 0 ? failures.join('; ') : null;

    let models = 0;
    for (const entry of Object.values(cache.endpoints)) {
      models += Object.keys(entry.models || {}).length;
    }
    lastSummary = { endpoints: targets.length, models };
    cache.updatedAt = new Date().toISOString();
    savePriceCache();
    return getPriceStatus();
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

export function getPriceStatus() {
  let models = 0;
  const sources = {};
  for (const [endpoint, entry] of Object.entries(cache.endpoints)) {
    const count = Object.keys(entry.models || {}).length;
    models += count;
    sources[endpoint] = {
      adapter: entry.adapter || 'unknown',
      source: entry.source,
      models: count,
      checkedAt: entry.checkedAt ? new Date(entry.checkedAt).toISOString() : null,
    };
  }
  return {
    enabled: ENABLED,
    cacheFile: CACHE_FILE,
    updatedAt: cache.updatedAt,
    lastCheckedAt,
    lastError,
    lastSummary,
    endpoints: Object.keys(cache.endpoints).length,
    models,
    sources,
  };
}
