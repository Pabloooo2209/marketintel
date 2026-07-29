const assert = require('assert');
const Core = require('../static/portfolio-core.js');

function tx(type, values = {}) {
  return Object.assign({
    id: `tx_${type}_${Math.random()}`,
    date: '2026-01-02T12:00:00Z',
    type,
    ticker: 'AAPL',
    shares: 10,
    price: 100,
    fee: 0,
    amount: 0
  }, values);
}

{
  const ledger = Core.processLedger([
    tx('Depósito', { ticker: '', shares: 0, price: 0, amount: 2000 }),
    tx('Compra', { fee: 1 }),
    tx('Venta', { date: '2026-02-02T12:00:00Z', shares: 4, price: 120, fee: 1 })
  ], 0);
  assert.strictEqual(ledger.positions.length, 1);
  assert.strictEqual(ledger.positions[0].shares, 6);
  assert.strictEqual(ledger.cash, 1478);
  assert.strictEqual(ledger.realized, 78.6);
}

{
  const ledger = Core.processLedger([
    tx('Abrir corto', { ticker: 'TSLA', shares: 5, price: 200, fee: 1 }),
    tx('Cubrir corto', { ticker: 'TSLA', date: '2026-02-02T12:00:00Z', shares: 2, price: 170, fee: 1 })
  ], 0);
  assert.strictEqual(ledger.positions[0].type, 'Corto');
  assert.strictEqual(ledger.positions[0].shares, 3);
  assert.strictEqual(ledger.cash, 658);
  assert.strictEqual(ledger.realized, 59.4);
}

{
  const transactions = [
    tx('Compra', { shares: 10, price: 150 }),
    tx('Dividendo', { ticker: 'AAPL', shares: 0, price: 0, amount: 25 }),
    tx('Comisión', { ticker: '', shares: 0, price: 0, amount: 3 })
  ];
  assert.strictEqual(Core.suggestedOpeningCash(transactions), 1478);
  const ledger = Core.processLedger(transactions, 1478);
  assert.strictEqual(ledger.cash, 0);
  assert.strictEqual(ledger.dividends, 25);
  assert.strictEqual(ledger.fees, 3);
  assert.strictEqual(ledger.realized, 22);
}

{
  const ledger = Core.processLedger([tx('Compra')], 1000);
  const snapshot = Core.buildSnapshot(ledger, {
    AAPL: { price: 110, change: 2, change_pct: 1.85 }
  });
  assert.strictEqual(snapshot.netLiquidation, 1100);
  assert.strictEqual(snapshot.unrealized, 100);
  assert.strictEqual(snapshot.dayPnl, 20);
  assert.strictEqual(snapshot.positions[0].allocation, 100);
}

console.log('portfolio-core: all tests passed');
