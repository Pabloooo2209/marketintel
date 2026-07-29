(function () {
  'use strict';

  const Core = window.MarketIntelPortfolioCore;
  if (!Core) return;

  const COLORS = ['#22d3ee', '#9b87f5', '#34d399', '#fbbf24', '#fb7185', '#60a5fa', '#f472b6', '#a3e635'];
  let ledger = null;
  let snapshot = null;
  let allocationChart = null;
  const historyCache = new Map();

  function el(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function amount(value) {
    return value == null || !Number.isFinite(Number(value))
      ? '—'
      : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(Number(value));
  }
  function compactAmount(value) {
    return value == null || !Number.isFinite(Number(value))
      ? '—'
      : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(Number(value));
  }
  function percent(value) {
    return value == null || !Number.isFinite(Number(value)) ? '—' : (Number(value) >= 0 ? '+' : '') + Number(value).toFixed(2) + '%';
  }
  function colorize(node, value) {
    if (!node) return;
    node.style.color = Number(value) > 0 ? 'var(--green)' : Number(value) < 0 ? 'var(--red)' : 'var(--text)';
  }
  function activeAccount() {
    return pfPortfolios.find(function (account) { return account.id === pfActiveId; }) || pfPortfolios[0];
  }
  function transactionKey(id) { return 'pf_transactions_' + id; }
  function positionKey(id) { return 'pf_positions_' + id; }

  function positionSignature(positions) {
    return (positions || []).map(function (p) {
      return [p.ticker, p.type || 'Largo', Number(p.shares || 0).toFixed(6), Number(p.avgCost || 0).toFixed(4)].join('|');
    }).sort().join(';');
  }

  function migrateAccounts() {
    let accountsChanged = false;
    pfPortfolios.forEach(function (account) {
      let transactions = pfLoadTransactions(account.id);
      const storedPositions = pfLoadPositions(account.id);

      if (!transactions.length && storedPositions.length) {
        const today = new Date().toISOString();
        transactions = storedPositions.map(function (position, index) {
          return Core.normalizeTransaction({
            id: 'legacy_' + account.id + '_' + index,
            date: today,
            type: 'Compra',
            ticker: position.ticker,
            shares: position.shares,
            price: position.avgCost,
            positionType: position.type || 'Largo',
            note: 'Posición migrada de la versión anterior'
          }, index);
        });
      } else {
        transactions = transactions.map(Core.normalizeTransaction);
      }

      if (account.openingCash == null) {
        account.openingCash = Core.suggestedOpeningCash(transactions);
        accountsChanged = true;
      }
      if (!account.currency) {
        account.currency = 'USD';
        accountsChanged = true;
      }
      if (account.ledgerVersion !== 3) {
        account.ledgerVersion = 3;
        accountsChanged = true;
      }

      const accountLedger = Core.processLedger(transactions, account.openingCash);
      if (storedPositions.length && positionSignature(accountLedger.positions) !== positionSignature(storedPositions)) {
        account.migrationNotice = 'Las posiciones se recalcularon desde las transacciones.';
        accountsChanged = true;
      }
      pfSaveTransactionsFor(account.id, accountLedger.transactions.slice().reverse());
      pfSavePositionsFor(account.id, accountLedger.positions);
    });
    if (accountsChanged) localStorage.setItem('pf_portfolios', JSON.stringify(pfPortfolios));
  }

  function syncAccount() {
    const account = activeAccount();
    pfTransactions = pfLoadTransactions(pfActiveId).map(Core.normalizeTransaction);
    ledger = Core.processLedger(pfTransactions, Number(account.openingCash || 0));
    pfTransactions = ledger.transactions.slice().reverse();
    pfPositions = ledger.positions;
    pfSaveTransactionsFor(pfActiveId, pfTransactions);
    pfSavePositionsFor(pfActiveId, pfPositions);
    snapshot = Core.buildSnapshot(ledger, pfQuotes);
    return snapshot;
  }

  function selectorRow(account) {
    const active = account.id === pfActiveId;
    return '<div class="pf3-selector-row' + (active ? ' active' : '') + '" data-account="' + escapeHtml(account.id) + '">' +
      '<button class="pf3-selector-main" onclick="pfSwitchPortfolio(\'' + escapeHtml(account.id) + '\')">' +
      '<strong>' + escapeHtml(account.name) + '</strong><small>' + escapeHtml(account.type || 'Standard') + ' · USD</small></button>' +
      '<button class="pf3-selector-edit" onclick="event.stopPropagation();pfOpenPortfolioModal(\'' + escapeHtml(account.id) + '\')" aria-label="Editar">✎</button>' +
      (pfPortfolios.length > 1 ? '<button class="pf3-selector-delete" onclick="event.stopPropagation();pfDeletePortfolio(\'' + escapeHtml(account.id) + '\')" aria-label="Eliminar">×</button>' : '') +
      '</div>';
  }

  function renderSelectorMenu() {
    const menu = el('pf-selector-menu');
    if (!menu) return;
    menu.innerHTML = pfPortfolios.map(selectorRow).join('') +
      '<button class="pf3-selector-new" onclick="pfToggleSelector();pfOpenPortfolioModal()">+ Crear otra cuenta</button>';
  }

  function toggleSelector() {
    const menu = el('pf-selector-menu');
    if (!menu) return;
    if (menu.style.display === 'block') {
      menu.style.display = 'none';
      return;
    }
    renderSelectorMenu();
    menu.style.display = 'block';
    setTimeout(function () {
      function close(event) {
        if (!event.target.closest('.pf3-selector-wrap')) {
          menu.style.display = 'none';
          document.removeEventListener('click', close);
        }
      }
      document.addEventListener('click', close);
    }, 0);
  }

  function switchPortfolio(id) {
    if (!pfPortfolios.some(function (account) { return account.id === id; })) return;
    pfActiveId = id;
    localStorage.setItem('pf_active_id', id);
    pfQuotes = {};
    mpSelectedPortfolioId = id;
    if (el('pf-selector-menu')) el('pf-selector-menu').style.display = 'none';
    if (el('pf-selector-label')) el('pf-selector-label').textContent = activeAccount().name;
    syncAccount();
    renderAll();
    pfRefreshAll();
    mpPopulatePortfolioSelect();
  }

  function openPortfolioModal(id) {
    const account = id ? pfPortfolios.find(function (item) { return item.id === id; }) : null;
    el('pf-portfolio-edit-id').value = account ? account.id : '';
    el('pf-portfolio-modal-title').textContent = account ? 'Editar cuenta' : 'Crear cuenta';
    el('pf-portfolio-name').value = account ? account.name : '';
    el('pf-portfolio-type').value = account ? (account.type || 'Standard') : 'Standard';
    el('pf-portfolio-cash').value = account ? Number(account.openingCash || 0).toFixed(2) : '0';
    el('pf-portfolio-modal-overlay').hidden = false;
  }

  function closePortfolioModal() {
    el('pf-portfolio-modal-overlay').hidden = true;
  }

  function savePortfolioModal() {
    const id = el('pf-portfolio-edit-id').value;
    const name = el('pf-portfolio-name').value.trim();
    const type = el('pf-portfolio-type').value;
    const openingCash = Math.max(0, Number(el('pf-portfolio-cash').value || 0));
    if (!name) return;
    if (id) {
      const account = pfPortfolios.find(function (item) { return item.id === id; });
      if (account) Object.assign(account, { name, type, openingCash, currency: 'USD', ledgerVersion: 3 });
    } else {
      const newId = (window.crypto && crypto.randomUUID) ? 'pf_' + crypto.randomUUID() : 'pf_' + Date.now();
      pfPortfolios.push({ id: newId, name, type, openingCash, currency: 'USD', ledgerVersion: 3 });
      localStorage.setItem('pf_portfolios', JSON.stringify(pfPortfolios));
      closePortfolioModal();
      switchPortfolio(newId);
      return;
    }
    localStorage.setItem('pf_portfolios', JSON.stringify(pfPortfolios));
    closePortfolioModal();
    syncAccount();
    renderAll();
  }

  function deletePortfolio(id) {
    if (pfPortfolios.length <= 1) return;
    const account = pfPortfolios.find(function (item) { return item.id === id; });
    if (!account || !confirm('¿Eliminar la cuenta “' + account.name + '” y todos sus movimientos?')) return;
    pfPortfolios = pfPortfolios.filter(function (item) { return item.id !== id; });
    localStorage.removeItem(positionKey(id));
    localStorage.removeItem(transactionKey(id));
    localStorage.setItem('pf_portfolios', JSON.stringify(pfPortfolios));
    switchPortfolio(pfPortfolios[0].id);
  }

  function operationIsTrade(type) {
    return Core.TRADE_TYPES.has(type);
  }

  function updateOperationPreview() {
    const type = el('pf-in-operation').value;
    const shares = Number(el('pf-in-shares').value || 0);
    const price = Number(el('pf-in-cost').value || 0);
    const fee = Number(el('pf-in-fee').value || 0);
    const cashAmount = Number(el('pf-in-amount').value || 0);
    const preview = el('pf-operation-preview');
    let movement = 0;
    if (type === 'Compra') movement = -(shares * price + fee);
    else if (type === 'Venta') movement = shares * price - fee;
    else if (type === 'Abrir corto') movement = shares * price - fee;
    else if (type === 'Cubrir corto') movement = -(shares * price + fee);
    else if (type === 'Depósito' || type === 'Dividendo') movement = cashAmount;
    else if (type === 'Retiro' || type === 'Comisión') movement = -cashAmount;
    preview.textContent = movement
      ? 'Movimiento estimado de efectivo: ' + (movement >= 0 ? '+' : '') + amount(movement)
      : 'El movimiento de efectivo se calculará automáticamente.';
    colorize(preview, movement);
  }

  function updateOperationForm() {
    const type = el('pf-in-operation').value;
    const isTrade = operationIsTrade(type);
    document.querySelectorAll('.pf3-trade-field').forEach(function (field) { field.hidden = !isTrade; });
    document.querySelectorAll('.pf3-cash-field').forEach(function (field) { field.hidden = isTrade; });
    const symbolField = document.querySelector('.pf3-symbol-field');
    if (symbolField && type === 'Dividendo') symbolField.hidden = false;
    el('pf-in-type').value = (type === 'Abrir corto' || type === 'Cubrir corto') ? 'Corto' : 'Largo';
    el('pf-operation-error').hidden = true;
    updateOperationPreview();
  }

  function openAddModal(preset) {
    const values = preset || {};
    el('pf-in-operation').value = values.type || 'Compra';
    el('pf-in-ticker').value = values.ticker || '';
    el('pf-in-shares').value = values.shares || '';
    el('pf-in-cost').value = values.price || '';
    el('pf-in-fee').value = values.fee || '0';
    el('pf-in-amount').value = values.amount || '';
    el('pf-in-note').value = values.note || '';
    el('pf-in-date').value = values.date || new Date().toISOString().slice(0, 10);
    el('pf-operation-error').hidden = true;
    updateOperationForm();
    el('pf-modal-overlay').hidden = false;
    setTimeout(function () {
      const target = operationIsTrade(el('pf-in-operation').value) ? el('pf-in-ticker') : el('pf-in-amount');
      if (target) target.focus();
    }, 40);
  }

  function closeAddModal() {
    el('pf-modal-overlay').hidden = true;
  }

  function addTransaction() {
    syncAccount();
    const type = el('pf-in-operation').value;
    const input = {
      id: (window.crypto && crypto.randomUUID) ? 'tx_' + crypto.randomUUID() : 'tx_' + Date.now(),
      date: el('pf-in-date').value + 'T12:00:00',
      type,
      ticker: el('pf-in-ticker').value.trim().toUpperCase(),
      shares: el('pf-in-shares').value,
      price: el('pf-in-cost').value,
      fee: el('pf-in-fee').value,
      amount: el('pf-in-amount').value,
      positionType: (type === 'Abrir corto' || type === 'Cubrir corto') ? 'Corto' : 'Largo',
      note: el('pf-in-note').value.trim(),
      schemaVersion: 3
    };
    const result = Core.validateTransaction(input, ledger);
    if (!result.ok) {
      el('pf-operation-error').textContent = result.message;
      el('pf-operation-error').hidden = false;
      return;
    }
    pfTransactions.push(result.transaction);
    pfSaveTransactionsFor(pfActiveId, pfTransactions);
    closeAddModal();
    syncAccount();
    renderAll();
    if (result.transaction.ticker) {
      pfFetchQuote(result.transaction.ticker).then(function () {
        syncAccount();
        renderAll();
        pfLoadChart();
      });
    } else {
      pfLoadChart();
    }
  }

  function openSellModal(ticker, type, shares) {
    const quote = pfQuotes[ticker];
    openAddModal({
      type: type === 'Corto' ? 'Cubrir corto' : 'Venta',
      ticker,
      shares,
      price: quote && quote.price ? quote.price : '',
      note: type === 'Corto' ? 'Cobertura de posición corta' : 'Venta de posición'
    });
  }

  function removeTransactionById(id) {
    const tx = pfTransactions.find(function (item) { return item.id === id; });
    if (!tx || !confirm('¿Eliminar esta operación y recalcular toda la cuenta?')) return;
    pfTransactions = pfTransactions.filter(function (item) { return item.id !== id; });
    pfSaveTransactionsFor(pfActiveId, pfTransactions);
    syncAccount();
    renderAll();
    pfLoadChart();
  }

  function removeTransactionByIndex(index) {
    const tx = pfTransactions[index];
    if (tx) removeTransactionById(tx.id);
  }

  function renderPositions() {
    syncAccount();
    const body = el('pf-positions-body');
    const footer = el('pf-positions-total');
    const empty = el('pf-empty');
    const table = body && body.closest('table');
    if (!body) return;
    if (!snapshot.positions.length) {
      body.innerHTML = '';
      footer.innerHTML = '';
      if (table) table.hidden = true;
      empty.hidden = false;
      return;
    }
    if (table) table.hidden = false;
    empty.hidden = true;
    body.innerHTML = snapshot.positions.map(function (position) {
      const sideLabel = position.type === 'Corto' ? 'Corto' : 'Largo';
      return '<tr>' +
        '<td data-label="Símbolo"><div class="pf-sym-cell">' + pfLogoHtml(position.ticker) + '<div class="pf3-position-meta"><strong>' + escapeHtml(position.ticker) + '</strong><small>' + sideLabel + '</small></div></div></td>' +
        '<td data-label="Posición">' + position.shares.toLocaleString('en-US', { maximumFractionDigits: 4 }) + '</td>' +
        '<td data-label="Costo promedio">' + amount(position.avgCost) + '</td>' +
        '<td data-label="Último">' + amount(position.price) + '</td>' +
        '<td data-label="Valor mercado">' + amount(position.marketValue) + '</td>' +
        '<td data-label="P&L día">' + pfGpBadge(amount(position.dayPnl), position.dayPnl) + '</td>' +
        '<td data-label="P&L no realizado">' + pfGpBadge(amount(position.unrealized), position.unrealized) + '</td>' +
        '<td data-label="P&L %">' + pfGpBadge(percent(position.unrealizedPct), position.unrealizedPct) + '</td>' +
        '<td data-label="Peso"><strong>' + position.allocation.toFixed(1) + '%</strong><div class="pf3-allocation-bar"><i style="width:' + Math.min(100, position.allocation) + '%"></i></div></td>' +
        '<td data-label="Acciones"><div class="pf3-row-actions"><button onclick="go(\'screener\');document.getElementById(\'ticker-input\').value=\'' + escapeHtml(position.ticker) + '\';fetchStock();">Analizar</button><button onclick="pfOpenSellModal(\'' + escapeHtml(position.ticker) + '\',\'' + sideLabel + '\',' + position.shares + ')">' + (position.type === 'Corto' ? 'Cubrir' : 'Vender') + '</button></div></td>' +
        '</tr>';
    }).join('');
    footer.innerHTML = '<tr><td>Total</td><td></td><td></td><td></td><td>' + amount(snapshot.longValue - snapshot.shortValue) + '</td><td>' + pfGpBadge(amount(snapshot.dayPnl), snapshot.dayPnl) + '</td><td>' + pfGpBadge(amount(snapshot.unrealized), snapshot.unrealized) + '</td><td>' + pfGpBadge(percent(snapshot.unrealizedPct), snapshot.unrealizedPct) + '</td><td>100%</td><td></td></tr>';
  }

  function txBadge(type) {
    let cls = 'buy';
    if (type === 'Venta' || type === 'Retiro' || type === 'Comisión') cls = type === 'Venta' ? 'sell' : type === 'Retiro' ? 'withdrawal' : 'fee';
    if (type === 'Abrir corto' || type === 'Cubrir corto') cls = 'short';
    if (type === 'Depósito') cls = 'deposit';
    if (type === 'Dividendo') cls = 'dividend';
    return '<span class="pf3-operation-badge ' + cls + '">' + escapeHtml(type) + '</span>';
  }

  function transactionCashImpact(tx) {
    const gross = tx.shares * tx.price;
    if (tx.type === 'Compra') return -(gross + tx.fee);
    if (tx.type === 'Venta' || tx.type === 'Abrir corto') return gross - tx.fee;
    if (tx.type === 'Cubrir corto') return -(gross + tx.fee);
    if (tx.type === 'Depósito' || tx.type === 'Dividendo') return tx.amount;
    if (tx.type === 'Retiro' || tx.type === 'Comisión') return -tx.amount;
    return 0;
  }

  function realizedForTransactions(transactions) {
    const sorted = Core.sortTransactions(transactions);
    const output = {};
    let previous = 0;
    sorted.forEach(function (tx, index) {
      const current = Core.processLedger(sorted.slice(0, index + 1), 0).realized;
      output[tx.id] = Core.round(current - previous, 2);
      previous = current;
    });
    return output;
  }

  function renderTransactions() {
    syncAccount();
    const body = el('pf-transactions-body');
    const empty = el('pf-tx-empty');
    const table = body && body.closest('table');
    const filter = el('pf-tx-filter') ? el('pf-tx-filter').value : 'Todas';
    const realizedMap = realizedForTransactions(pfTransactions);
    const filtered = filter === 'Todas' ? pfTransactions : pfTransactions.filter(function (tx) { return tx.type === filter; });
    if (el('pf-tx-count')) el('pf-tx-count').textContent = filtered.length + (filtered.length === 1 ? ' movimiento' : ' movimientos');
    if (!filtered.length) {
      body.innerHTML = '';
      if (table) table.hidden = true;
      empty.hidden = false;
      return;
    }
    if (table) table.hidden = false;
    empty.hidden = true;
    body.innerHTML = filtered.map(function (tx) {
      const realized = realizedMap[tx.id] || 0;
      return '<tr>' +
        '<td data-label="Fecha">' + new Date(tx.date).toLocaleDateString('es-DO') + '</td>' +
        '<td data-label="Operación">' + txBadge(tx.type) + '</td>' +
        '<td data-label="Símbolo"><strong>' + escapeHtml(tx.ticker || 'USD') + '</strong>' + (tx.note ? '<small class="pf3-tx-note">' + escapeHtml(tx.note) + '</small>' : '') + '</td>' +
        '<td data-label="Cantidad">' + (tx.shares || '—') + '</td>' +
        '<td data-label="Precio">' + (tx.price ? amount(tx.price) : '—') + '</td>' +
        '<td data-label="Comisión">' + amount(tx.fee || (tx.type === 'Comisión' ? tx.amount : 0)) + '</td>' +
        '<td data-label="Movimiento efectivo">' + pfGpBadge((transactionCashImpact(tx) >= 0 ? '+' : '') + amount(transactionCashImpact(tx)), transactionCashImpact(tx)) + '</td>' +
        '<td data-label="P&L realizado">' + (realized ? pfGpBadge(amount(realized), realized) : '—') + '</td>' +
        '<td data-label="Acciones"><div class="pf3-row-actions"><button onclick="pfRemoveTxById(\'' + escapeHtml(tx.id) + '\')">Eliminar</button></div></td>' +
        '</tr>';
    }).join('');
  }

  function renderStats() {
    syncAccount();
    const values = [
      ['pf-total-value', snapshot.netLiquidation],
      ['pf-cash-value', snapshot.cash],
      ['pf-buying-power', snapshot.buyingPower],
      ['pf-day-change', snapshot.dayPnl],
      ['pf-total-gain', snapshot.unrealized],
      ['pf-realized-gain', snapshot.realized],
      ['pf-total-cost', snapshot.costBasis],
      ['pf-long-value', snapshot.longValue],
      ['pf-short-value', snapshot.shortValue],
      ['pf-gross-exposure', snapshot.grossExposure],
      ['pf-dividends', snapshot.dividends],
      ['pf-fees', snapshot.fees]
    ];
    values.forEach(function (entry) {
      const node = el(entry[0]);
      if (node) node.textContent = amount(entry[1]);
    });
    ['pf-day-change', 'pf-total-gain', 'pf-realized-gain', 'pf-cash-value'].forEach(function (id) {
      const map = { 'pf-day-change': snapshot.dayPnl, 'pf-total-gain': snapshot.unrealized, 'pf-realized-gain': snapshot.realized, 'pf-cash-value': snapshot.cash };
      colorize(el(id), map[id]);
    });
    el('pf-day-change-pct').textContent = percent(snapshot.dayPnlPct);
    el('pf-total-gain-pct').textContent = percent(snapshot.unrealizedPct);
    el('pf-income-summary').textContent = 'Dividendos ' + amount(snapshot.dividends);
    el('pf-net-sub').textContent = snapshot.positions.length + (snapshot.positions.length === 1 ? ' posición abierta' : ' posiciones abiertas');
    el('pf-position-count').textContent = snapshot.positions.length + (snapshot.positions.length === 1 ? ' posición' : ' posiciones');
    el('pf-allocation-total').textContent = compactAmount(snapshot.grossExposure);
    el('pf-last-update').textContent = new Date().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
    el('pf-account-status').textContent = activeAccount().name + ' · USD · ' + (snapshot.priced === snapshot.positions.length ? 'Precios actualizados' : 'Esperando algunos precios');
    colorize(el('pf-day-change-pct'), snapshot.dayPnlPct);
    colorize(el('pf-total-gain-pct'), snapshot.unrealizedPct);
    if (el('pf-chg-day')) {
      el('pf-chg-day').textContent = amount(snapshot.dayPnl) + ' · ' + percent(snapshot.dayPnlPct);
      colorize(el('pf-chg-day'), snapshot.dayPnl);
    }
  }

  function renderAllocation() {
    syncAccount();
    const list = el('pf-allocation-list');
    if (!list) return;
    if (!snapshot.positions.length) {
      list.innerHTML = '<div class="pf3-muted">Sin posiciones abiertas.</div>';
      if (allocationChart) { allocationChart.destroy(); allocationChart = null; }
      return;
    }
    const positions = snapshot.positions.slice().sort(function (a, b) { return b.absValue - a.absValue; });
    list.innerHTML = positions.slice(0, 6).map(function (position, index) {
      return '<div class="pf3-allocation-row"><i style="background:' + COLORS[index % COLORS.length] + '"></i><span>' + escapeHtml(position.ticker) + '</span><strong>' + position.allocation.toFixed(1) + '%</strong></div>';
    }).join('');
    const canvas = el('pf-allocation-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (allocationChart) allocationChart.destroy();
    allocationChart = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: positions.map(function (p) { return p.ticker; }),
        datasets: [{ data: positions.map(function (p) { return p.absValue; }), backgroundColor: positions.map(function (_, i) { return COLORS[i % COLORS.length]; }), borderWidth: 0, hoverOffset: 4 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '73%',
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (context) { return context.label + ': ' + amount(context.raw); } } } }
      }
    });
  }

  async function fetchHistory(ticker, period) {
    const key = ticker + '|' + period;
    if (historyCache.has(key)) return historyCache.get(key);
    const promise = fetch('/history/' + encodeURIComponent(ticker) + '?period=' + period, { signal: AbortSignal.timeout(18000) })
      .then(function (response) { if (!response.ok) throw new Error('Sin historial'); return response.json(); })
      .catch(function () { return null; });
    historyCache.set(key, promise);
    return promise;
  }

  function periodForRange(days, customRange) {
    if (customRange) {
      const duration = Math.ceil((new Date(customRange.to) - new Date(customRange.from)) / 86400000);
      if (duration > 365) return '5y';
      if (duration > 182) return '1y';
      if (duration > 30) return '6mo';
      return '1mo';
    }
    if (days > 365) return '5y';
    if (days > 182) return '1y';
    if (days > 30) return '6mo';
    return '1mo';
  }

  async function buildAccountSeries(portfolioId, days, customRange) {
    const account = pfPortfolios.find(function (item) { return item.id === portfolioId; });
    if (!account) return null;
    const transactions = pfLoadTransactions(portfolioId).map(Core.normalizeTransaction);
    const tickers = Array.from(new Set(transactions.filter(function (tx) { return operationIsTrade(tx.type) && tx.ticker; }).map(function (tx) { return tx.ticker; })));
    const period = periodForRange(days, customRange);
    const histories = await Promise.all(tickers.map(function (ticker) { return fetchHistory(ticker, period); }));
    const byTicker = {};
    histories.forEach(function (history, index) { if (history && history.dates) byTicker[tickers[index]] = history; });
    let dates = Array.from(new Set(Object.values(byTicker).flatMap(function (history) { return history.dates; }))).sort();
    if (customRange) dates = dates.filter(function (date) { return date >= customRange.from && date <= customRange.to; });
    else dates = dates.slice(-days);
    if (!dates.length) {
      const txDates = transactions.map(function (tx) { return tx.date.slice(0, 10); }).sort();
      if (txDates.length) dates = [txDates[txDates.length - 1]];
      else return null;
    }
    const priceMaps = {};
    Object.keys(byTicker).forEach(function (ticker) {
      priceMaps[ticker] = {};
      byTicker[ticker].dates.forEach(function (date, index) { priceMaps[ticker][date] = byTicker[ticker].prices[index]; });
    });
    const latest = {};
    const values = dates.map(function (date) {
      Object.keys(priceMaps).forEach(function (ticker) {
        if (priceMaps[ticker][date] != null) latest[ticker] = priceMaps[ticker][date];
      });
      const dayLedger = Core.processLedger(transactions, Number(account.openingCash || 0), { until: date + 'T23:59:59' });
      const quotes = {};
      Object.keys(latest).forEach(function (ticker) { quotes[ticker] = { price: latest[ticker], change: 0, change_pct: 0 }; });
      return Core.buildSnapshot(dayLedger, quotes).netLiquidation;
    });
    return { dates, prices: values };
  }

  function valueChange(series, daysAgo) {
    if (!series || !series.prices.length) return null;
    const lastIndex = series.prices.length - 1;
    const lastDate = new Date(series.dates[lastIndex]);
    const target = new Date(lastDate.getTime() - daysAgo * 86400000);
    let firstIndex = 0;
    for (let index = lastIndex; index >= 0; index -= 1) {
      if (new Date(series.dates[index]) <= target) { firstIndex = index; break; }
    }
    const first = Number(series.prices[firstIndex]);
    const last = Number(series.prices[lastIndex]);
    return { amount: last - first, percent: first ? (last - first) / first * 100 : 0 };
  }

  function paintPeriod(id, change) {
    const node = el(id);
    if (!node) return;
    if (!change) { node.textContent = '—'; return; }
    node.textContent = amount(change.amount) + ' · ' + percent(change.percent);
    colorize(node, change.amount);
  }

  async function loadPortfolioChart() {
    syncAccount();
    const canvas = el('chart-portfolio');
    if (!canvas || typeof Chart === 'undefined') return;
    const rangeDays = { '1D': 2, '1S': 7, '1M': 30, '3M': 90, '6M': 182, '1A': 365 };
    const days = rangeDays[pfRange] || 30;
    const series = await buildAccountSeries(pfActiveId, days, pfCustomRange);
    const empty = el('pf-chart-empty');
    if (!series || !series.prices.length) {
      if (pfChartInstance) { pfChartInstance.destroy(); pfChartInstance = null; }
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    if (pfChartInstance) pfChartInstance.destroy();
    const first = series.prices[0];
    const last = series.prices[series.prices.length - 1];
    const positive = last >= first;
    const stroke = positive ? '#34d399' : '#fb7185';
    pfChartInstance = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels: series.dates, datasets: [{ data: series.prices, borderColor: stroke, borderWidth: 2, pointRadius: 0, tension: .28, fill: true, backgroundColor: positive ? 'rgba(52,211,153,.055)' : 'rgba(251,113,133,.055)', spanGaps: true }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (context) { return 'Valor neto: ' + amount(context.raw); } } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#66758a', font: { family: 'IBM Plex Mono', size: 8 }, maxTicksLimit: 6, maxRotation: 0 } },
          y: { position: 'right', grid: { color: 'rgba(148,163,184,.08)' }, ticks: { color: '#66758a', font: { family: 'IBM Plex Mono', size: 8 }, callback: function (value) { return compactAmount(value); } } }
        }
      }
    });
    paintPeriod('pf-chg-week', valueChange(series, 7));
    paintPeriod('pf-chg-month', valueChange(series, 30));
    paintPeriod('pf-chg-1h', { amount: last - first, percent: first ? (last - first) / first * 100 : 0 });
  }

  function setRange(range) {
    pfRange = range;
    pfCustomRange = null;
    el('pf-date-from').value = '';
    el('pf-date-to').value = '';
    document.querySelectorAll('.pf-range').forEach(function (button) { button.classList.toggle('active', button.dataset.range === range); });
    loadPortfolioChart();
  }

  function applyCustomRange() {
    const from = el('pf-date-from').value;
    const to = el('pf-date-to').value;
    if (!from || !to || from > to) return;
    pfCustomRange = { from, to };
    document.querySelectorAll('.pf-range').forEach(function (button) { button.classList.remove('active'); });
    loadPortfolioChart();
  }

  async function refreshAll() {
    syncAccount();
    const tickers = Array.from(new Set(pfPositions.map(function (position) { return position.ticker; })));
    if (tickers.length) {
      const controller = new AbortController();
      const timer = setTimeout(function () { controller.abort(); }, 30000);
      try {
        const response = await fetch('/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tickers }),
          signal: controller.signal
        });
        if (!response.ok) throw new Error('No se pudieron actualizar las cotizaciones');
        const quotes = await response.json();
        tickers.forEach(function (ticker) {
          if (quotes[ticker] && quotes[ticker].price != null) {
            pfQuotes[ticker] = Object.assign({}, pfQuotes[ticker] || {}, quotes[ticker]);
          }
        });
      } catch (_) {
        // Conserva las últimas cotizaciones visibles si Yahoo está temporalmente limitado.
      } finally {
        clearTimeout(timer);
      }
    }
    syncAccount();
    renderAll();
    loadPortfolioChart();
  }

  function switchTab(tab) {
    document.querySelectorAll('.pf-tab').forEach(function (button) { button.classList.toggle('active', button.dataset.t === tab); });
    el('pf-positions-panel').hidden = tab !== 'positions';
    el('pf-transactions-panel').hidden = tab !== 'transactions';
  }

  function exportCsv() {
    const blob = new Blob(['\ufeff' + Core.transactionsToCsv(pfTransactions)], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'MarketIntel-' + safeName(activeAccount().name) + '-transacciones.csv');
  }

  function exportAccount() {
    const account = activeAccount();
    const payload = {
      version: 3,
      exportedAt: new Date().toISOString(),
      account: Object.assign({}, account),
      transactions: Core.sortTransactions(pfTransactions)
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'MarketIntel-' + safeName(account.name) + '-cuenta.json');
  }

  function importAccount(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const payload = JSON.parse(reader.result);
        if (payload.version !== 3 || !payload.account || !Array.isArray(payload.transactions)) throw new Error('Formato incompatible');
        const id = (window.crypto && crypto.randomUUID) ? 'pf_' + crypto.randomUUID() : 'pf_' + Date.now();
        const name = String(payload.account.name || 'Cuenta importada') + ' (importada)';
        pfPortfolios.push({ id, name, type: payload.account.type || 'Standard', openingCash: Number(payload.account.openingCash || 0), currency: 'USD', ledgerVersion: 3 });
        pfSaveTransactionsFor(id, payload.transactions.map(Core.normalizeTransaction));
        localStorage.setItem('pf_portfolios', JSON.stringify(pfPortfolios));
        switchPortfolio(id);
      } catch (error) {
        alert('No se pudo importar la cuenta. Selecciona una copia JSON creada por MarketIntel.');
      } finally {
        event.target.value = '';
      }
    };
    reader.readAsText(file);
  }

  function safeName(value) { return String(value || 'cuenta').trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'cuenta'; }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function renderAll() {
    if (el('pf-selector-label')) el('pf-selector-label').textContent = activeAccount().name;
    renderStats();
    renderPositions();
    renderTransactions();
    renderAllocation();
    mpPopulatePortfolioSelect();
  }

  function wireModalInputs() {
    ['pf-in-shares', 'pf-in-cost', 'pf-in-fee', 'pf-in-amount'].forEach(function (id) {
      if (el(id)) el(id).addEventListener('input', updateOperationPreview);
    });
    [el('pf-modal-overlay'), el('pf-portfolio-modal-overlay')].forEach(function (overlay) {
      if (!overlay) return;
      overlay.addEventListener('click', function (event) {
        if (event.target === overlay) overlay.hidden = true;
      });
    });
  }

  function initialize() {
    migrateColumnPreferences();
    migrateAccounts();
    syncAccount();
    wireModalInputs();
    updateOperationForm();
    renderAll();
    if (document.querySelector('#sec-portafolio.active')) refreshAll();
  }

  function migrateColumnPreferences() {
    const schemaKey = 'mi_pf_columns_schema';
    if (localStorage.getItem(schemaKey) === '4') return;

    let preferences = {};
    try {
      preferences = JSON.parse(localStorage.getItem('mi_table_columns') || '{}') || {};
    } catch (_) {
      preferences = {};
    }

    // La tabla tipo IBKR tiene una estructura diferente. Las preferencias
    // antiguas por índice podían ocultar columnas equivocadas.
    delete preferences.positions;
    delete preferences.transactions;
    localStorage.setItem('mi_table_columns', JSON.stringify(preferences));
    localStorage.setItem(schemaKey, '4');

    document.querySelectorAll('.pf3-table th, .pf3-table td').forEach((cell) => {
      if (cell.style.display === 'none') cell.style.display = '';
    });
  }

  window.pfToggleSelector = toggleSelector;
  window.pfRenderSelectorMenu = renderSelectorMenu;
  window.pfSwitchPortfolio = switchPortfolio;
  window.pfOpenPortfolioModal = openPortfolioModal;
  window.pfClosePortfolioModal = closePortfolioModal;
  window.pfSavePortfolioModal = savePortfolioModal;
  window.pfDeletePortfolio = deletePortfolio;
  window.pfOpenAddModal = openAddModal;
  window.pfCloseAddModal = closeAddModal;
  window.pfUpdateOperationForm = updateOperationForm;
  window.pfAddPosition = addTransaction;
  window.pfOpenSellModal = openSellModal;
  window.pfRemoveTx = removeTransactionByIndex;
  window.pfRemoveTxById = removeTransactionById;
  window.pfRenderPositionsTable = renderPositions;
  window.pfRenderTransactionsTable = renderTransactions;
  window.pfUpdateStats = renderStats;
  window.pfRefreshAll = refreshAll;
  window.pfLoadChart = loadPortfolioChart;
  window.pfSetRange = setRange;
  window.pfApplyCustomRange = applyCustomRange;
  window.pfSwitchTab = switchTab;
  window.pfExportCsv = exportCsv;
  window.pfExportAccount = exportAccount;
  window.pfImportAccount = importAccount;
  window.mpBuildPortfolioSeries = function (days, portfolioId) {
    return buildAccountSeries(portfolioId, days, mpCustomRange);
  };

  initialize();
})();
