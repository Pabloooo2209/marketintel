"""Utilidades financieras e integraciones opcionales de MarketIntel.

Este módulo no depende de Flask ni de yfinance para que sus cálculos puedan
probarse por separado. Yahoo Finance sigue siendo la fuente base de la app;
FMP, SEC EDGAR y FRED se usan únicamente cuando están configurados.
"""

import math
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone


_REMOTE_CACHE = {}


def _valid_number(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def first_number(mapping, *keys):
    if not isinstance(mapping, dict):
        return None
    for key in keys:
        value = _valid_number(mapping.get(key))
        if value is not None:
            return value
    return None


def normalize_dividend_yield(value):
    """Normaliza el dividend yield de Yahoo a porcentaje.

    Según la versión/campo, Yahoo puede entregar 0.0167 o 1.67 para 1.67%.
    """
    number = _valid_number(value)
    if number is None or number < 0:
        return None
    percent = number * 100 if number <= 1 else number
    return round(percent, 2)


def normalize_debt_to_equity(value):
    """Convierte el D/E de Yahoo (frecuentemente 388.9) a ratio 3.889x."""
    number = _valid_number(value)
    if number is None:
        return None
    ratio = number / 100 if abs(number) > 20 else number
    return round(ratio, 3)


def calculate_operating_expense_runway(total_cash, annual_operating_expenses):
    """Cash total ÷ (Operating Expenses anuales ÷ 12)."""
    cash = _valid_number(total_cash)
    expenses = _valid_number(annual_operating_expenses)
    if cash is None or expenses is None:
        return None, None
    monthly = abs(expenses) / 12
    if monthly <= 0:
        return None, None
    return round(monthly, 2), round(cash / monthly, 1)


def relative_difference(actual, expected):
    actual_number = _valid_number(actual)
    expected_number = _valid_number(expected)
    if actual_number is None or expected_number in (None, 0):
        return None
    return abs(actual_number - expected_number) / abs(expected_number) * 100


def build_identity_checks(data):
    """Comprueba identidades contables sin inventar valores faltantes."""
    checks = []

    def add(check_id, label, actual, expected, tolerance=5):
        difference = relative_difference(actual, expected)
        if difference is None:
            checks.append({
                'id': check_id, 'label': label, 'status': 'unavailable',
                'detail': 'No hay datos suficientes para verificarla.',
                'actual_value': _valid_number(actual),
                'expected_value': _valid_number(expected),
            })
            return
        checks.append({
            'id': check_id,
            'label': label,
            'status': 'pass' if difference <= tolerance else 'review',
            'difference_pct': round(difference, 2),
            'actual_value': _valid_number(actual),
            'expected_value': _valid_number(expected),
            'detail': (
                f'Diferencia {difference:.2f}% (tolerancia {tolerance}%).'
            ),
        })

    price = _valid_number(data.get('price'))
    shares = _valid_number(data.get('shares_outstanding'))
    add(
        'market_cap_identity',
        'Market Cap ≈ precio × acciones',
        data.get('market_cap'),
        price * shares if price is not None and shares is not None else None,
        4,
    )

    eps = _valid_number(data.get('eps'))
    add(
        'pe_identity',
        'P/E ≈ precio ÷ EPS TTM',
        data.get('pe'),
        price / eps if price is not None and eps not in (None, 0) else None,
        5,
    )

    revenue = _valid_number(data.get('revenue_ttm'))
    net_income = _valid_number(data.get('net_income_ttm'))
    add(
        'margin_identity',
        'Margen neto ≈ ganancia neta ÷ Revenue TTM',
        data.get('profit_margin'),
        (net_income / revenue * 100)
        if revenue not in (None, 0) and net_income is not None else None,
        5,
    )
    add(
        'revenue_ttm_identity',
        'Revenue TTM = suma de 4 trimestres',
        data.get('revenue_ttm'),
        data.get('revenue_ttm_calculated')
        if data.get('revenue_quarters_count') == 4 else None,
        0.1,
    )
    return checks


def build_cross_source_checks(data, fmp_metrics=None, sec_metrics=None):
    """Contrasta solo métricas comparables disponibles en más de una fuente."""
    checks = []
    fmp_metrics = fmp_metrics or {}
    sec_metrics = sec_metrics or {}

    def add(check_id, label, first, second, tolerance):
        difference = relative_difference(first, second)
        if difference is None:
            return
        checks.append({
            'id': check_id,
            'label': label,
            'status': 'pass' if difference <= tolerance else 'review',
            'difference_pct': round(difference, 2),
            'actual_value': _valid_number(first),
            'expected_value': _valid_number(second),
            'detail': (
                f'Diferencia entre fuentes {difference:.2f}% '
                f'(tolerancia {tolerance}%).'
            ),
        })

    add(
        'fmp_revenue',
        'Revenue TTM: Yahoo vs FMP',
        data.get('revenue_ttm'),
        fmp_metrics.get('revenue_ttm'),
        8,
    )
    add(
        'fmp_cash',
        'Cash: Yahoo vs FMP',
        data.get('total_cash'),
        fmp_metrics.get('cash'),
        12,
    )
    add(
        'fmp_debt',
        'Deuda total: Yahoo vs FMP',
        data.get('total_debt'),
        fmp_metrics.get('debt'),
        12,
    )
    fmp_margin = _valid_number(fmp_metrics.get('net_margin'))
    if fmp_margin is not None and abs(fmp_margin) <= 1:
        fmp_margin *= 100
    add(
        'fmp_net_margin',
        'Margen neto: Yahoo vs FMP',
        data.get('profit_margin'),
        fmp_margin,
        5,
    )
    sec_cash = sec_metrics.get('cash_latest')
    add(
        'sec_cash',
        'Cash: Yahoo vs último reporte SEC',
        data.get('total_cash'),
        sec_cash.get('value') if isinstance(sec_cash, dict) else None,
        12,
    )
    return checks


def _cached_json(requests_module, url, params=None, headers=None, ttl=900, timeout=8):
    key = (url, tuple(sorted((params or {}).items())))
    cached = _REMOTE_CACHE.get(key)
    if cached and time.time() - cached[0] < ttl:
        return cached[1]
    response = requests_module.get(
        url, params=params or {}, headers=headers or {}, timeout=timeout
    )
    response.raise_for_status()
    value = response.json()
    _REMOTE_CACHE[key] = (time.time(), value)
    return value


def fetch_fmp_snapshot(requests_module, ticker, api_key):
    """Obtiene un contraste normalizado de FMP sin reemplazar Yahoo."""
    if not api_key:
        return {'configured': False, 'status': 'disabled', 'metrics': {}}
    base = 'https://financialmodelingprep.com/stable'
    endpoints = {
        'ratios': 'ratios-ttm',
        'metrics': 'key-metrics-ttm',
        'income': 'income-statement',
        'balance': 'balance-sheet-statement',
        'cashflow': 'cash-flow-statement',
        'estimates': 'analyst-estimates',
    }
    raw = {name: [] for name in endpoints}
    errors = []

    def load_endpoint(name, path):
        params = {'symbol': ticker, 'apikey': api_key}
        if name in {'income', 'balance', 'cashflow'}:
            params.update({'period': 'quarter', 'limit': 4})
        if name == 'estimates':
            params.update({'period': 'annual', 'limit': 4})
        result = _cached_json(
            requests_module, f'{base}/{path}', params=params, ttl=900
        )
        return name, result if isinstance(result, list) else []

    # Evita que seis endpoints retrasen la ficha uno detrás de otro.
    with ThreadPoolExecutor(max_workers=len(endpoints)) as executor:
        futures = {
            executor.submit(load_endpoint, name, path): name
            for name, path in endpoints.items()
        }
        for future in as_completed(futures):
            name = futures[future]
            try:
                _, result = future.result()
                raw[name] = result
            except Exception as exc:
                errors.append(f'{name}: {type(exc).__name__}')
                raw[name] = []

    ratios = raw['ratios'][0] if raw['ratios'] else {}
    metrics = raw['metrics'][0] if raw['metrics'] else {}
    income = raw['income']
    balance = raw['balance'][0] if raw['balance'] else {}
    cashflow = raw['cashflow'][0] if raw['cashflow'] else {}
    estimates = raw['estimates'][0] if raw['estimates'] else {}
    revenue_ttm = sum(
        value for value in (first_number(row, 'revenue') for row in income[:4])
        if value is not None
    ) if income else None
    if revenue_ttm == 0:
        revenue_ttm = None

    normalized = {
        'revenue_ttm': revenue_ttm,
        'net_income_ttm': (
            sum(value for value in (
                first_number(row, 'netIncome') for row in income[:4]
            ) if value is not None) if income else None
        ),
        'gross_margin': first_number(ratios, 'grossProfitMarginTTM', 'grossProfitMargin'),
        'ebitda_margin': first_number(ratios, 'ebitdaMarginTTM', 'ebitdaMargin'),
        'operating_margin': first_number(ratios, 'operatingProfitMarginTTM', 'operatingProfitMargin'),
        'net_margin': first_number(ratios, 'netProfitMarginTTM', 'netProfitMargin'),
        'roa': first_number(ratios, 'returnOnAssetsTTM', 'returnOnAssets'),
        'roe': first_number(ratios, 'returnOnEquityTTM', 'returnOnEquity'),
        'price_to_book': first_number(ratios, 'priceToBookRatioTTM', 'priceToBookRatio'),
        'peg_ratio': first_number(ratios, 'priceEarningsToGrowthRatioTTM', 'priceEarningsToGrowthRatio'),
        'enterprise_to_revenue': first_number(metrics, 'evToSalesTTM', 'evToSales'),
        'enterprise_to_ebitda': first_number(metrics, 'enterpriseValueOverEBITDATTM', 'enterpriseValueOverEBITDA'),
        'price_to_fcf': first_number(ratios, 'priceToFreeCashFlowsRatioTTM', 'priceToFreeCashFlowsRatio'),
        'current_ratio': first_number(ratios, 'currentRatioTTM', 'currentRatio'),
        'cash': first_number(balance, 'cashAndShortTermInvestments', 'cashAndCashEquivalents'),
        'debt': first_number(balance, 'totalDebt'),
        'free_cash_flow': first_number(cashflow, 'freeCashFlow'),
        'research_and_development': (
            sum(value for value in (
                first_number(row, 'researchAndDevelopmentExpenses')
                for row in income[:4]
            ) if value is not None) if income else None
        ),
        'estimated_revenue_next_year': first_number(
            estimates, 'estimatedRevenueAvg', 'estimatedRevenueHigh'
        ),
        'estimated_eps_next_year': first_number(
            estimates, 'estimatedEpsAvg', 'estimatedEpsHigh'
        ),
    }
    return {
        'configured': True,
        'status': 'ok' if any(value is not None for value in normalized.values()) else 'limited',
        'metrics': normalized,
        'errors': errors,
        'updated_at': datetime.now(timezone.utc).isoformat(),
    }


def _latest_sec_fact(company_facts, tags):
    facts = company_facts.get('facts', {}).get('us-gaap', {})
    candidates = []
    for tag in tags:
        units = facts.get(tag, {}).get('units', {})
        for unit_rows in units.values():
            for row in unit_rows:
                value = _valid_number(row.get('val'))
                if value is None:
                    continue
                candidates.append((
                    row.get('filed', ''),
                    row.get('end', ''),
                    value,
                    row.get('form', ''),
                ))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    filed, end, value, form = candidates[0]
    return {'value': value, 'period_end': end, 'filed': filed, 'form': form}


def fetch_sec_snapshot(requests_module, ticker, user_agent):
    """Consulta Company Facts de SEC para valores oficiales de compañías US."""
    if not user_agent or '@' not in user_agent:
        return {
            'configured': False, 'status': 'disabled', 'metrics': {},
            'note': 'Define SEC_USER_AGENT con nombre y correo.',
        }
    headers = {'User-Agent': user_agent, 'Accept-Encoding': 'gzip, deflate'}
    try:
        tickers = _cached_json(
            requests_module,
            'https://www.sec.gov/files/company_tickers.json',
            headers=headers,
            ttl=86400,
        )
        row = next(
            (item for item in tickers.values()
             if str(item.get('ticker', '')).upper() == ticker.upper()),
            None,
        )
        if not row:
            return {'configured': True, 'status': 'not_applicable', 'metrics': {}}
        cik = str(row['cik_str']).zfill(10)
        facts = _cached_json(
            requests_module,
            f'https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json',
            headers=headers,
            ttl=3600,
        )
        metrics = {
            'revenue_latest': _latest_sec_fact(
                facts, ('RevenueFromContractWithCustomerExcludingAssessedTax',
                        'Revenues', 'SalesRevenueNet')
            ),
            'net_income_latest': _latest_sec_fact(facts, ('NetIncomeLoss',)),
            'shares_latest': _latest_sec_fact(
                facts, ('CommonStocksIncludingAdditionalPaidInCapitalMember',
                        'CommonStockSharesOutstanding')
            ),
            'cash_latest': _latest_sec_fact(
                facts, ('CashAndCashEquivalentsAtCarryingValue',
                        'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents')
            ),
        }
        return {
            'configured': True, 'status': 'ok', 'cik': cik,
            'company': facts.get('entityName'), 'metrics': metrics,
            'updated_at': datetime.now(timezone.utc).isoformat(),
        }
    except Exception as exc:
        return {
            'configured': True, 'status': 'error', 'metrics': {},
            'error': f'{type(exc).__name__}: {exc}',
        }


FRED_SERIES = {
    'fed_upper': ('DFEDTARU', 'Tasa FED superior', 'percent'),
    'fed_lower': ('DFEDTARL', 'Tasa FED inferior', 'percent'),
    'cpi': ('CPIAUCSL', 'CPI', 'index'),
    'core_pce': ('PCEPILFE', 'Core PCE', 'index'),
    'unemployment': ('UNRATE', 'Desempleo', 'percent'),
    'payrolls': ('PAYEMS', 'Nóminas no agrícolas', 'thousands'),
    'gdp': ('GDP', 'PIB', 'billions'),
    'treasury_10y': ('DGS10', 'Treasury 10Y', 'percent'),
}


def fetch_fred_snapshot(requests_module, api_key):
    if not api_key:
        return {'configured': False, 'status': 'disabled', 'series': {}}
    series = {}
    errors = []

    def fetch_one(entry):
        key, (series_id, label, unit) = entry
        try:
            result = _cached_json(
                requests_module,
                'https://api.stlouisfed.org/fred/series/observations',
                params={
                    'series_id': series_id,
                    'api_key': api_key,
                    'file_type': 'json',
                    'sort_order': 'desc',
                    'limit': 13,
                },
                ttl=3600,
            )
            observations = result.get('observations') or [{}]
            observation = observations[0]
            value = _valid_number(observation.get('value'))
            item = {
                'id': series_id, 'label': label, 'unit': unit,
                'value': value, 'date': observation.get('date'),
            }
            numeric = [
                _valid_number(row.get('value')) for row in observations
            ]
            if key in {'cpi', 'core_pce'} and value is not None and len(numeric) >= 13 and numeric[12] not in (None, 0):
                item['display_value'] = round((value / numeric[12] - 1) * 100, 2)
                item['display_unit'] = 'percent_yoy'
            elif key == 'payrolls' and value is not None and len(numeric) >= 2 and numeric[1] is not None:
                item['display_value'] = round(value - numeric[1], 0)
                item['display_unit'] = 'change_thousands'
            elif key == 'gdp' and value is not None and len(numeric) >= 5 and numeric[4] not in (None, 0):
                item['display_value'] = round((value / numeric[4] - 1) * 100, 2)
                item['display_unit'] = 'percent_yoy'
            else:
                item['display_value'] = value
                item['display_unit'] = unit
            return key, item, None
        except Exception as exc:
            return key, None, f'{series_id}: {type(exc).__name__}'

    # Las series son independientes. Consultarlas en paralelo evita que la
    # primera apertura de Pulso macro tarde la suma de ocho solicitudes.
    with ThreadPoolExecutor(max_workers=min(8, len(FRED_SERIES))) as executor:
        futures = [
            executor.submit(fetch_one, entry)
            for entry in FRED_SERIES.items()
        ]
        for future in as_completed(futures):
            key, item, error = future.result()
            if item is not None:
                series[key] = item
            if error:
                errors.append(error)

    return {
        'configured': True,
        'status': 'ok' if series else 'error',
        'series': series,
        'errors': errors,
        'updated_at': datetime.now(timezone.utc).isoformat(),
    }
