(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MarketIntelPortfolioCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TRADE_TYPES = new Set(['Compra', 'Venta', 'Abrir corto', 'Cubrir corto']);
  const CASH_TYPES = new Set(['Depósito', 'Retiro', 'Dividendo', 'Comisión']);

  function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : (fallback == null ? 0 : fallback);
  }

  function round(value, decimals) {
    const factor = Math.pow(10, decimals == null ? 8 : decimals);
    return Math.round((number(value) + Number.EPSILON) * factor) / factor;
  }

  function txId(tx, index) {
    if (tx && tx.id) return String(tx.id);
    const raw = [
      tx && tx.date,
      tx && tx.type,
      tx && tx.ticker,
      tx && tx.shares,
      tx && tx.price,
      index
    ].join('|');
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i += 1) {
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return 'tx_' + (hash >>> 0).toString(36);
  }

  function normalizeType(tx) {
    const raw = String((tx && tx.type) || '').trim();
    const positionType = String((tx && tx.positionType) || (tx && tx.assetSide) || 'Largo');
    if (raw === 'Compra' && positionType === 'Corto') return 'Abrir corto';
    if (raw === 'Venta' && positionType === 'Corto') return 'Cubrir corto';
    const aliases = {
      Buy: 'Compra',
      Sell: 'Venta',
      Deposit: 'Depósito',
      Withdrawal: 'Retiro',
      Dividend: 'Dividendo',
      Fee: 'Comisión',
      Short: 'Abrir corto',
      Cover: 'Cubrir corto'
    };
    return aliases[raw] || raw || 'Compra';
  }

  function normalizeTransaction(tx, index) {
    const type = normalizeType(tx);
    const ticker = String((tx && tx.ticker) || '').trim().toUpperCase();
    const date = (tx && tx.date) ? new Date(tx.date).toISOString() : new Date().toISOString();
    const shares = Math.max(0, number(tx && tx.shares));
    const price = Math.max(0, number(tx && tx.price));
    const fee = Math.max(0, number(tx && tx.fee));
    const explicitAmount = number(tx && tx.amount, NaN);
    const amount = Number.isFinite(explicitAmount)
      ? Math.abs(explicitAmount)
      : Math.abs(number(tx && tx.total, shares * price));
    const positionType = (type === 'Abrir corto' || type === 'Cubrir corto') ? 'Corto' : 'Largo';
    return {
      id: txId(tx, index),
      date,
      type,
      ticker,
      shares: round(shares),
      price: round(price),
      fee: round(fee, 2),
      amount: round(amount, 2),
      total: round(shares * price, 2),
      positionType,
      note: String((tx && tx.note) || '').trim(),
      schemaVersion: 3
    };
  }

  function sortTransactions(transactions) {
    return (transactions || [])
      .map(normalizeTransaction)
      .sort(function (a, b) {
        const byDate = new Date(a.date) - new Date(b.date);
        return byDate || a.id.localeCompare(b.id);
      });
  }

  function emptyPosition(ticker, side) {
    return {
      ticker,
      type: side,
      shares: 0,
      avgCost: 0,
      costBasis: 0,
      realized: 0
    };
  }

  function getPosition(map, ticker, side) {
    const key = ticker + '|' + side;
    if (!map[key]) map[key] = emptyPosition(ticker, side);
    return map[key];
  }

  function processLedger(transactions, openingCash, options) {
    const opts = options || {};
    const until = opts.until ? new Date(opts.until).getTime() : Infinity;
    const sorted = sortTransactions(transactions);
    const positions = {};
    const realizedByTicker = {};
    const warnings = [];
    let cash = number(openingCash);
    let realized = 0;
    let dividends = 0;
    let fees = 0;
    let deposits = 0;
    let withdrawals = 0;

    sorted.forEach(function (tx) {
      if (new Date(tx.date).getTime() > until) return;
      const gross = tx.shares * tx.price;
      fees += tx.fee;

      if (tx.type === 'Depósito') {
        cash += tx.amount;
        deposits += tx.amount;
        return;
      }
      if (tx.type === 'Retiro') {
        cash -= tx.amount;
        withdrawals += tx.amount;
        return;
      }
      if (tx.type === 'Dividendo') {
        cash += tx.amount;
        dividends += tx.amount;
        realized += tx.amount;
        if (tx.ticker) realizedByTicker[tx.ticker] = number(realizedByTicker[tx.ticker]) + tx.amount;
        return;
      }
      if (tx.type === 'Comisión') {
        cash -= tx.amount;
        fees += tx.amount;
        realized -= tx.amount;
        return;
      }
      if (!TRADE_TYPES.has(tx.type)) return;

      const side = (tx.type === 'Abrir corto' || tx.type === 'Cubrir corto') ? 'Corto' : 'Largo';
      const pos = getPosition(positions, tx.ticker, side);
      const opens = tx.type === 'Compra' || tx.type === 'Abrir corto';

      if (opens) {
        const addedBasis = gross + tx.fee;
        const totalShares = pos.shares + tx.shares;
        pos.costBasis += addedBasis;
        pos.shares = round(totalShares);
        pos.avgCost = pos.shares ? pos.costBasis / pos.shares : 0;
        cash += side === 'Corto' ? gross - tx.fee : -(gross + tx.fee);
        return;
      }

      if (tx.shares > pos.shares + 1e-8) {
        warnings.push({
          transactionId: tx.id,
          message: 'La operación excede la posición disponible en ' + tx.ticker + '.'
        });
      }
      const closingShares = Math.min(tx.shares, pos.shares);
      const basisRemoved = pos.shares ? pos.costBasis * (closingShares / pos.shares) : 0;
      const tradeRealized = side === 'Corto'
        ? (pos.avgCost - tx.price) * closingShares - tx.fee
        : (tx.price - pos.avgCost) * closingShares - tx.fee;
      realized += tradeRealized;
      realizedByTicker[tx.ticker] = number(realizedByTicker[tx.ticker]) + tradeRealized;
      cash += side === 'Corto' ? -(gross + tx.fee) : gross - tx.fee;
      pos.shares = round(pos.shares - closingShares);
      pos.costBasis = Math.max(0, round(pos.costBasis - basisRemoved));
      pos.avgCost = pos.shares ? pos.costBasis / pos.shares : 0;
      pos.realized += tradeRealized;
    });

    const openPositions = Object.values(positions)
      .filter(function (position) { return position.shares > 1e-8; })
      .map(function (position) {
        return {
          ticker: position.ticker,
          shares: round(position.shares),
          avgCost: round(position.avgCost),
          type: position.type,
          costBasis: round(position.costBasis, 2),
          realized: round(number(realizedByTicker[position.ticker]), 2)
        };
      });

    return {
      cash: round(cash, 2),
      positions: openPositions,
      realized: round(realized, 2),
      realizedByTicker,
      dividends: round(dividends, 2),
      fees: round(fees, 2),
      deposits: round(deposits, 2),
      withdrawals: round(withdrawals, 2),
      warnings,
      transactions: sorted
    };
  }

  function cashWithZeroOpening(transactions) {
    return processLedger(transactions, 0).cash;
  }

  function suggestedOpeningCash(transactions) {
    return Math.max(0, round(-cashWithZeroOpening(transactions), 2));
  }

  function quoteValue(quotes, ticker, field) {
    const quote = (quotes || {})[ticker];
    return quote && quote[field] != null ? number(quote[field], NaN) : NaN;
  }

  function buildSnapshot(ledger, quotes) {
    let longValue = 0;
    let shortValue = 0;
    let grossExposure = 0;
    let costBasis = 0;
    let unrealized = 0;
    let dayPnl = 0;
    let priced = 0;

    const positions = ledger.positions.map(function (position) {
      const price = quoteValue(quotes, position.ticker, 'price');
      const change = quoteValue(quotes, position.ticker, 'change');
      const changePct = quoteValue(quotes, position.ticker, 'change_pct');
      const sign = position.type === 'Corto' ? -1 : 1;
      const marketValue = Number.isFinite(price) ? sign * price * position.shares : NaN;
      const pnl = Number.isFinite(price)
        ? sign * (price - position.avgCost) * position.shares
        : NaN;
      const pnlPct = position.costBasis && Number.isFinite(pnl) ? pnl / position.costBasis * 100 : NaN;
      const daily = Number.isFinite(change) ? sign * change * position.shares : NaN;
      const absValue = Number.isFinite(price) ? Math.abs(price * position.shares) : 0;

      costBasis += position.costBasis;
      if (Number.isFinite(marketValue)) {
        priced += 1;
        grossExposure += absValue;
        if (position.type === 'Corto') shortValue += absValue;
        else longValue += absValue;
      }
      if (Number.isFinite(pnl)) unrealized += pnl;
      if (Number.isFinite(daily)) dayPnl += daily;

      return Object.assign({}, position, {
        price,
        marketValue,
        absValue,
        unrealized: pnl,
        unrealizedPct: pnlPct,
        dayPnl: daily,
        dayPnlPct: Number.isFinite(changePct) ? sign * changePct : NaN,
        allocation: 0
      });
    });

    const netLiquidation = ledger.cash + longValue - shortValue;
    const previousNet = netLiquidation - dayPnl;
    positions.forEach(function (position) {
      position.allocation = grossExposure ? position.absValue / grossExposure * 100 : 0;
    });

    return {
      cash: ledger.cash,
      netLiquidation: round(netLiquidation, 2),
      longValue: round(longValue, 2),
      shortValue: round(shortValue, 2),
      grossExposure: round(grossExposure, 2),
      costBasis: round(costBasis, 2),
      unrealized: round(unrealized, 2),
      unrealizedPct: costBasis ? unrealized / costBasis * 100 : 0,
      realized: ledger.realized,
      dividends: ledger.dividends,
      fees: ledger.fees,
      dayPnl: round(dayPnl, 2),
      dayPnlPct: previousNet ? dayPnl / previousNet * 100 : 0,
      buyingPower: round(Math.max(ledger.cash, 0), 2),
      positions,
      priced,
      warnings: ledger.warnings
    };
  }

  function validateTransaction(input, ledger) {
    const tx = normalizeTransaction(input, 0);
    if (!TRADE_TYPES.has(tx.type) && !CASH_TYPES.has(tx.type)) {
      return { ok: false, message: 'Selecciona una operación válida.' };
    }
    if (TRADE_TYPES.has(tx.type)) {
      if (!/^[A-Z0-9.^=-]{1,15}$/.test(tx.ticker)) {
        return { ok: false, message: 'Escribe un ticker válido.' };
      }
      if (!(tx.shares > 0) || !(tx.price > 0)) {
        return { ok: false, message: 'Cantidad y precio deben ser mayores que cero.' };
      }
      if (tx.type === 'Venta' || tx.type === 'Cubrir corto') {
        const side = tx.type === 'Venta' ? 'Largo' : 'Corto';
        const available = ((ledger && ledger.positions) || []).find(function (position) {
          return position.ticker === tx.ticker && position.type === side;
        });
        if (!available || tx.shares > available.shares + 1e-8) {
          return {
            ok: false,
            message: 'Solo tienes ' + round(available ? available.shares : 0, 4) + ' acciones disponibles.'
          };
        }
      }
    } else if (!(tx.amount > 0)) {
      return { ok: false, message: 'El importe debe ser mayor que cero.' };
    }
    return { ok: true, transaction: tx };
  }

  function csvEscape(value) {
    const text = String(value == null ? '' : value);
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function transactionsToCsv(transactions) {
    const header = ['Fecha', 'Operación', 'Símbolo', 'Cantidad', 'Precio', 'Comisión', 'Importe', 'Nota'];
    const rows = sortTransactions(transactions).map(function (tx) {
      return [
        tx.date.slice(0, 10),
        tx.type,
        tx.ticker,
        tx.shares || '',
        tx.price || '',
        tx.fee || '',
        tx.amount || '',
        tx.note
      ].map(csvEscape).join(',');
    });
    return [header.join(',')].concat(rows).join('\n');
  }

  return {
    TRADE_TYPES,
    CASH_TYPES,
    normalizeTransaction,
    sortTransactions,
    processLedger,
    suggestedOpeningCash,
    buildSnapshot,
    validateTransaction,
    transactionsToCsv,
    round
  };
});
