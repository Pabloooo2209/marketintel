const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('index.html', 'utf8');

assert(source.includes('requestMacroSnapshot(force=false)'));
assert(source.includes("fetchJSONRetry('/macro', {timeout:35000}, 2)"));
assert(source.includes("if(id==='indicadores'){"));
assert(source.includes("loadMacroSnapshot({force:true})"));
assert(source.includes('if(tickerRefreshInterval) clearInterval(tickerRefreshInterval)'));
assert(source.includes("const quotes = await fetchJSONRetry('/batch'"));
assert(!source.includes("fetch('/macro', {signal: AbortSignal.timeout(7000)"));
assert(!source.includes("fetch('/macro', {signal: AbortSignal.timeout(6000)"));

console.log('macro auto-load: all tests passed');
