import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeUsageCost,
  endpointKey,
  isDeepSeekPeak,
  mergeModelPrices,
  modelIdCandidates,
  parseAliyunConsolidatedPricing,
  parseAliyunPricing,
  parseAnthropicPricing,
  parseBigModelPricing,
  parseDeepSeekPricing,
  parseHuggingFacePricing,
  parseMoonshotPricing,
  parseOpenRouterModels,
  selectPriceRates,
} from '../prices.js';

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${expected}, got ${actual}`);

test('computeUsageCost uses per-million input and output rates', () => {
  const cost = computeUsageCost(
    { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 },
    { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  );
  close(cost, 0.3 + 0.6);
});

test('computeUsageCost bills cache reads and writes', () => {
  const cost = computeUsageCost(
    { input: 1_000_000, output: 0, cacheRead: 2_000_000, cacheWrite: 1_000_000 },
    { input: 1, output: 0, cacheRead: 0.1, cacheWrite: 1.25 },
  );
  close(cost, 1 + 0.2 + 1.25);
});

test('computeUsageCost applies the matching request-wide tier', () => {
  const rates = {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    tiers: [
      { inputTokensAbove: 200_000, input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
      { inputTokensAbove: 500_000, input: 3, output: 6, cacheRead: 0, cacheWrite: 0 },
    ],
  };
  close(computeUsageCost({ input: 150_000, output: 100_000 }, rates), 0.15 + 0.2);
  close(computeUsageCost({ input: 300_000, output: 100_000 }, rates), 0.6 + 0.4);
  close(computeUsageCost({ input: 600_000, output: 100_000 }, rates), 1.8 + 0.6);
});

test('computeUsageCost charges 2x input for 1h cache writes', () => {
  const cost = computeUsageCost(
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 400_000 },
    { input: 5, output: 0, cacheRead: 0, cacheWrite: 1 },
  );
  close(cost, 5 * 2 * 0.4 + 1 * 0.6);
});

test('endpointKey groups models by the host they call', () => {
  assert.equal(endpointKey('https://api.deepseek.com/v1'), 'api.deepseek.com');
  assert.equal(endpointKey('https://api.deepseek.com/anthropic'), 'api.deepseek.com');
  assert.equal(endpointKey('https://openrouter.ai/api/v1'), 'openrouter.ai');
  assert.equal(endpointKey('https://proxy.example.com/v1'), 'proxy.example.com');
  assert.equal(endpointKey('not a url'), null);
  assert.equal(endpointKey(''), null);
});

test('selectPriceRates follows the DeepSeek peak windows', () => {
  const price = {
    peak: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
    offPeak: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    peakRule: 'deepseek',
  };
  assert.equal(selectPriceRates(price, '2026-01-05T02:00:00Z').period, 'peak');
  assert.equal(selectPriceRates(price, '2026-01-05T12:00:00Z').period, 'offPeak');
  assert.equal(selectPriceRates(price, '2026-01-04T02:00:00Z').period, 'offPeak');
  assert.equal(selectPriceRates({ rates: { input: 1, output: 2 } }, null).period, null);
});

const DEEPSEEK_TABLE = `
<table>
<tr><td colspan="3">MODEL</td><td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro</td></tr>
<tr><td rowspan="6">PRICING<sup>(2)</sup></td><td rowspan="2">1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
<tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
<tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>
<tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
<tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr>
</table>`;

test('parseDeepSeekPricing reads peak and off-peak columns per model', () => {
  const models = parseDeepSeekPricing(DEEPSEEK_TABLE);
  assert.ok(models);
  assert.deepEqual(models['deepseek-flash'].peak, {
    input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0,
  });
  assert.deepEqual(models['deepseek-flash'].offPeak, {
    input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0,
  });
  assert.equal(models['deepseek-flash'].currency, 'USD');
  assert.equal(models['deepseek-v4-pro'].peak.output, 3.96);
});

const DEEPSEEK_CN_TABLE = `
<table>
<tr><td colspan="3">模型</td><td>deepseek-flash <sup>(1)</sup></td><td>deepseek-v4-pro</td></tr>
<tr><td rowspan="6">价格<sup>(2)</sup></td><td rowspan="2">百万tokens输入<br>（缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>
<tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>
<tr><td rowspan="2">百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>1元</td><td>4.5元</td></tr>
<tr><td>高峰时段</td><td>2元</td><td>9.0元</td></tr>
<tr><td rowspan="2">百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
<tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr>
</table>`;

test('parseDeepSeekPricing reads the Chinese CNY page', () => {
  const models = parseDeepSeekPricing(DEEPSEEK_CN_TABLE, 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing');
  assert.equal(models['deepseek-flash'].currency, 'CNY');
  assert.deepEqual(models['deepseek-flash'].peak, {
    input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0,
  });
  assert.deepEqual(models['deepseek-flash'].offPeak, {
    input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0,
  });
  assert.equal(models['deepseek-v4-pro'].offPeak.output, 13.5);
});

test('parseDeepSeekPricing rejects unrelated tables', () => {
  assert.equal(parseDeepSeekPricing('<table><tr><td>Search</td><td>$0.75</td></tr></table>'), null);
});

test('isDeepSeekPeak follows the published UTC windows', () => {
  assert.equal(isDeepSeekPeak('2026-01-05T02:00:00Z'), true); // Monday 02:00 UTC
  assert.equal(isDeepSeekPeak('2026-01-05T07:30:00Z'), true); // Monday 07:30 UTC
  assert.equal(isDeepSeekPeak('2026-01-05T12:00:00Z'), false);
  assert.equal(isDeepSeekPeak('2026-01-04T02:00:00Z'), false); // Sunday
  assert.equal(isDeepSeekPeak('2026-01-03T07:30:00Z'), false); // Saturday
});

test('parseOpenRouterModels converts per-token pricing to per-million', () => {
  const models = parseOpenRouterModels({
    data: [{
      id: 'deepseek/deepseek-chat',
      pricing: {
        prompt: '0.0000003',
        completion: '0.0000012',
        input_cache_read: '0.00000006',
      },
    }],
  });
  assert.deepEqual(models['deepseek/deepseek-chat'].rates, {
    input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0,
  });
  assert.equal(models['deepseek/deepseek-chat'].currency, 'USD');
});

const BIGMODEL_MD = `
| 模型名称 | 上下文 | 输入单价（元/百万 Tokens） | 输出单价（元/百万 Tokens） | 缓存存储（元/百万 Tokens/小时） | 缓存命中（元/百万 Tokens） |
| - | - | - | - | - | - |
| GLM-5.3 | 1M | 8 | 28 | 限时免费 | 2 |
| GLM-4.7 | 输入 [0, 32K)，输出 [0, 0.2K) | 2 | 8 | 限时免费 | 0.4 |
| GLM-4.7 | 输入 [0, 32K)，输出 ≥0.2K | 3 | 14 | 限时免费 | 0.6 |
| GLM-4.7 | 输入 \\[32K, 200K) | 4 | 16 | 限时免费 | 0.8 |
| GLM-4.7-Flash | 200K | 免费 | 免费 | 限时免费 | 免费 |
`;

test('mergeModelPrices keeps old entries and applies new ones', () => {
  const merged = mergeModelPrices(
    { old: { rates: { input: 1 } }, changed: { rates: { input: 1 } } },
    { changed: { rates: { input: 2 } }, added: { rates: { input: 3 } } },
  );
  assert.deepEqual(Object.keys(merged).sort(), ['added', 'changed', 'old']);
  assert.equal(merged.changed.rates.input, 2);
  assert.equal(merged.old.rates.input, 1);
});

test('parseBigModelPricing reads CNY prices and tiers', () => {
  const models = parseBigModelPricing(BIGMODEL_MD);
  assert.equal(models['glm-5.3'].currency, 'CNY');
  assert.deepEqual(models['glm-5.3'].rates, {
    input: 8, output: 28, cacheRead: 2, cacheWrite: 0,
  });

  const glm47 = models['glm-4.7'];
  assert.equal(glm47.rates.input, 2);
  assert.equal(glm47.rates.output, 8);
  assert.equal(glm47.rates.cacheRead, 0.4);
  assert.equal(glm47.rates.tiers.length, 2);
  assert.deepEqual(
    glm47.rates.tiers.find((tier) => tier.outputTokensAbove === 200),
    { inputTokensAbove: 0, outputTokensAbove: 200, input: 3, output: 14, cacheRead: 0.6, cacheWrite: 0 },
  );
  assert.deepEqual(
    glm47.rates.tiers.find((tier) => tier.inputTokensAbove === 32000),
    { inputTokensAbove: 32000, input: 4, output: 16, cacheRead: 0.8, cacheWrite: 0 },
  );
  assert.equal(models['glm-4.7-flash'].rates.input, 0);
});

test('computeUsageCost applies GLM output-length tiers', () => {
  const rates = {
    input: 2, output: 8, cacheRead: 0.4, cacheWrite: 0,
    tiers: [
      { inputTokensAbove: 0, outputTokensAbove: 200, input: 3, output: 14, cacheRead: 0.6, cacheWrite: 0 },
      { inputTokensAbove: 32000, input: 4, output: 16, cacheRead: 0.8, cacheWrite: 0 },
    ],
  };
  close(computeUsageCost({ input: 10_000, output: 100 }, rates), 0.02 + 0.0008);
  close(computeUsageCost({ input: 10_000, output: 300 }, rates), 0.03 + 0.0042);
  close(computeUsageCost({ input: 40_000, output: 300 }, rates), 0.16 + 0.0048);
});


const ANTHROPIC_HTML = `
<div><h3>Fable 5.1</h3><p>Next generation</p>
<p>Prompt caching Read $0.25 / MTok Write $12.50 / MTok Input $10 / MTok Output $50 / MTok</p></div>
<div><h3>Haiku 5.5</h3><p>Fast</p>
<p>Prompt caching Prompts ≤ 100K tokens Read $0.01 / MTok Write $0.125 / MTok Prompts > 100K tokens Read $0.05 / MTok Write $0.625 / MTok Input Prompts ≤ 100K tokens $0.10 / MTok Prompts > 100K tokens $0.50 / MTok Output Prompts ≤ 100K tokens $0.50 / MTok Prompts > 100K tokens $2.50 / MTok</p></div>
`;

test('parseAnthropicPricing reads USD prices and prompt tiers', () => {
  const models = parseAnthropicPricing(ANTHROPIC_HTML);
  assert.deepEqual(models['claude-fable-5-1'].rates, {
    input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5,
  });
  assert.deepEqual(models['claude-haiku-5-5'].rates.tiers, [{
    inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625,
  }]);
});

test('parseHuggingFacePricing uses the first live provider', () => {
  const models = parseHuggingFacePricing({
    data: [{
      id: 'deepseek-ai/Test',
      providers: [
        { provider: 'offline', status: 'error', pricing: { input: 99, output: 99 } },
        { provider: 'novita', status: 'live', pricing: { input: 0.3, output: 1.2 } },
      ],
    }],
  });
  assert.deepEqual(models['deepseek-ai/Test'].rates, {
    input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0,
  });
  assert.equal(models['deepseek-ai/Test'].currency, 'USD');
});

test('parseMoonshotPricing reads CNY rows from the rendered page', () => {
  const html = 'children:`kimi-k2.6`}),`¥6.50 / MTok`,`¥27.00 / MTok`,`¥1.10 / MTok` '
    + 'children:`kimi-k3`}),`¥20.00 / MTok`,`¥100.00 / MTok`,`¥2.00 / MTok`,`¥20.00 / MTok`,`¥40.00 / MTok`';
  const models = parseMoonshotPricing(html);
  assert.deepEqual(models['kimi-k2.6'].rates, {
    input: 6.5, output: 27, cacheRead: 1.1, cacheWrite: 0,
  });
  assert.deepEqual(models['kimi-k3'].rates, {
    input: 20, output: 100, cacheRead: 2, cacheWrite: 20,
  });
  assert.equal(models['kimi-k3'].currency, 'CNY');
});

test('parseAliyunPricing reads Beijing CNY prices', () => {
  const html = '<h2>模型价格</h2><p>华北 2（北京） 计费项 价格（元） 单位 '
    + '输入 12 每百万 tokens 输出 36 每百万 tokens '
    + '输入（缓存命中） 1.5 每百万 tokens 显式缓存创建 15 每百万 tokens</p>';
  assert.deepEqual(parseAliyunPricing(html), {
    currency: 'CNY',
    rates: { input: 12, output: 36, cacheRead: 1.5, cacheWrite: 15 },
  });
});

test('modelIdCandidates also matches an undated catalog id', () => {
  assert.deepEqual(modelIdCandidates('claude-haiku-4-5-20251001'), [
    'claude-haiku-4-5-20251001',
    'claude-haiku-4-5',
  ]);
  assert.deepEqual(modelIdCandidates('deepseek-flash'), ['deepseek-flash']);
});


test('parseAliyunConsolidatedPricing falls back to the all-models table', () => {
  const html = '<p>模型价格 华北 2（北京） 模型 ID（Model ID） 服务部署范围 '
    + '输入单价 缓存命中输入单价 输出单价 qwen3.8-omni-flash 中国内地 0.8 元 0.1 元 2.7 元 '
    + 'qwen3.8-max 中国内地 12 元 36 元</p>';
  assert.deepEqual(parseAliyunConsolidatedPricing(html, 'qwen3.8-omni-flash'), {
    currency: 'CNY',
    rates: { input: 0.8, output: 2.7, cacheRead: 0.1, cacheWrite: 0 },
  });
  assert.deepEqual(parseAliyunConsolidatedPricing(html, 'qwen3.8-max'), {
    currency: 'CNY',
    rates: { input: 12, output: 36, cacheRead: 0, cacheWrite: 0 },
  });
});
