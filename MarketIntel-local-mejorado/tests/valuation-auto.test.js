const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(new URL('../index.html', `file://${__filename}`), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const fnIndex = html.indexOf(marker);
  assert.notEqual(fnIndex, -1, `No se encontró ${name}`);
  const asyncIndex = html.lastIndexOf('async ', fnIndex);
  const start = asyncIndex >= 0 && fnIndex - asyncIndex < 8 ? asyncIndex : fnIndex;
  const open = html.indexOf('{', fnIndex);
  let depth = 0;
  let quote = null;
  let escaped = false;

  for(let i = open; i < html.length; i++) {
    const char = html[i];
    if(quote) {
      if(escaped) escaped = false;
      else if(char === '\\') escaped = true;
      else if(char === quote) quote = null;
      continue;
    }
    if(char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if(char === '{') depth++;
    if(char === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`No se pudo extraer ${name}`);
}

function makeElement(value = '') {
  const classes = new Set();
  return {
    value,
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
    },
  };
}

const ids = [
  'val-ticker','val-status',
  'gn-eps','gn-bvps','gn-price','gn-result',
  'gf-eps','gf-growth','gf-price','gf-result',
  'pt-eps','pt-pe','pt-price','pt-mcap-now','pt-mcap-fut','pt-mcap-method','pt-result',
  'spt-price','spt-mcap-now','spt-mcap-fut','spt-mcap-method','spt-result',
  'val-summary','val-summary-content',
];
const elements = Object.fromEntries(ids.map(id => [id, makeElement()]));
elements['val-ticker'].value = 'TEST';

const context = vm.createContext({
  console,
  document: {getElementById: id => elements[id]},
  AbortSignal: {timeout: () => ({})},
  AbortController: class {
    constructor() { this.signal = {}; }
    abort() {}
  },
  setTimeout,
  clearTimeout,
  fetch: null,
});
context.fetchJSONRetry = async (...args) => {
  const response = await context.fetch(...args);
  if(!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const functions = [
  'fmtVal','upsideStr','calcGraham','calcGrahamFormula','setFutureCapMethod',
  'estimateFutureMarketCap','applyAutoFutureMarketCap','syncFutureMarketCap',
  'recalcAutoFutureMarketCap','calcPriceTarget','updateValSummary',
  'calcSimplePriceTarget','valAutoFill',
];
const source = `let valuationProjectionContext = null;\n${functions.map(extractFunction).join('\n')}`;
vm.runInContext(source, context);

async function autoFill(data) {
  context.fetch = async () => ({ok: true, json: async () => data});
  await vm.runInContext('valAutoFill()', context);
}

(async () => {
  await autoFill({
    name: 'Caso positivo', price: 100, market_cap: 1_000_000_000,
    shares_outstanding: 10_000_000, eps: 5, book_value: 50,
    eps_forward: 6, pe: 20, revenue_growth: 10,
  });
  assert.equal(elements['pt-mcap-fut'].value, '1.200');
  assert.equal(Number(elements['spt-mcap-fut'].value), 1_200_000_000);
  assert.match(elements['spt-result'].innerHTML, /\+20\.0%/);
  assert.match(elements['pt-mcap-method'].textContent, /EPS Forward 6\.00/);

  await autoFill({
    name: 'Caso negativo', price: 100, market_cap: 1_000_000_000,
    shares_outstanding: 10_000_000, eps_forward: 4, pe: 20,
  });
  assert.equal(elements['pt-mcap-fut'].value, '0.800');
  assert.match(elements['spt-result'].innerHTML, /-20\.0%/);

  elements['pt-mcap-fut'].value = '1.100';
  vm.runInContext("syncFutureMarketCap('pt')", context);
  assert.equal(Number(elements['spt-mcap-fut'].value), 1_100_000_000);
  assert.match(elements['spt-result'].innerHTML, /\+10\.0%/);
  assert.equal(elements['pt-mcap-fut'].dataset.projection, 'manual');

  await autoFill({
    name: 'Fallback Revenue', price: 100, market_cap: 1_000_000_000,
    revenue_ttm: 500_000_000, revenue_growth: 10,
  });
  assert.equal(elements['pt-mcap-fut'].value, '1.100');
  assert.match(elements['pt-mcap-method'].textContent, /Revenue proyectado/);

  await autoFill({
    name: 'Fallback Consenso', price: 100, market_cap: 1_000_000_000,
    analyst_target: 130,
  });
  assert.equal(elements['pt-mcap-fut'].value, '1.300');
  assert.match(elements['pt-mcap-method'].textContent, /consenso/);

  elements['gn-eps'].value = '';
  elements['pt-eps'].value = '';
  elements['pt-mcap-fut'].value = '';
  elements['gf-eps'].value = '10';
  elements['gf-growth'].value = '-20';
  elements['gf-price'].value = '100';
  vm.runInContext('calcGrahamFormula()', context);
  assert.match(elements['gf-result'].innerHTML, /2×0%/);
  assert.match(elements['val-summary-content'].innerHTML, /\$85\.00/);

  console.log('Valuation auto-fill tests: OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
