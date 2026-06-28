from flask import Flask, jsonify, send_file, request as flask_request
from flask_cors import CORS
import yfinance as yf
import traceback
import os
import math

try:
    import requests as http_req
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

try:
    import pandas as pd
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False

app = Flask(__name__)
CORS(app)

CHATBOT_SYSTEM = """Eres MarketBot, el asistente financiero de MarketIntel. Especializado en value investing y análisis de mercados bursátiles.

Los 7 principios del usuario:
1. Price Target — upside ≥20% sobre el precio actual
2. Crecimiento en ventas — mínimo +20% YoY
3. SMA 200 — precio por debajo de la media = descuento/oportunidad de compra
4. Conference Call — revisar guidance del CEO, tono y márgenes
5. P/E Ratio — razonable (<50x trailing)
6. Beta/Volatilidad — Beta <2.5, ATR manejable
7. Williams %R — zona de sobreventa en semanal (−80 a −100)

Indicadores macro que conoces: FED rates, CPI, Core PCE, NFP/Desempleo, PIB/GDP, ISM PMI, Confianza del Consumidor.
Análisis fundamental: EPS (TTM y Forward), P/E, Graham Number (√22.5×EPS×BVPS), Graham formula (EPS×(8.5+2g)), Fair Value (EPS Fwd×15), runway de caja.
Análisis técnico: SMA/EMA, ATR, Beta, Williams %R, Golden Cross, Death Cross, soporte/resistencia.

Responde siempre en español. Sé conciso pero completo. No des recomendaciones directas de compra/venta — da análisis objetivo y educativo.
Cuando te pregunten por una acción específica, menciona cuáles de los 7 principios podrían cumplirse o fallar basándote en los datos disponibles."""

def clean(val):
    if val is None:
        return None
    try:
        if math.isnan(float(val)) or math.isinf(float(val)):
            return None
    except (TypeError, ValueError):
        pass
    return val

def clean_list(lst):
    if lst is None:
        return None
    return [clean(v) for v in lst]

@app.route('/')
def home():
    return send_file('index.html')

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})

@app.route('/stock/<ticker>')
def get_stock(ticker):
    try:
        ticker = ticker.upper().strip()
        t = yf.Ticker(ticker)
        info = t.info

        if not info or (info.get('regularMarketPrice') is None and info.get('currentPrice') is None):
            return jsonify({'error': f'Ticker "{ticker}" no encontrado'}), 404

        hist = t.history(period="1y")

        price = info.get('currentPrice') or info.get('regularMarketPrice')
        prev_close = info.get('previousClose') or info.get('regularMarketPreviousClose')
        change = round(price - prev_close, 2) if price and prev_close else None
        change_pct = round((change / prev_close) * 100, 2) if change and prev_close else None

        sma200 = None
        above_sma200 = None
        if len(hist) >= 20:
            period = min(200, len(hist))
            sma200 = round(hist['Close'].rolling(period).mean().dropna().iloc[-1], 2)
            above_sma200 = bool(price > sma200) if price else None

        atr = None
        if len(hist) >= 14:
            hl = hist['High'] - hist['Low']
            atr = round(hl.rolling(14).mean().iloc[-1], 2)

        rev_growth = None
        try:
            fin = t.financials
            if fin is not None and not fin.empty and 'Total Revenue' in fin.index:
                revs = fin.loc['Total Revenue'].dropna()
                if len(revs) >= 2:
                    rev_growth = round((revs.iloc[0] - revs.iloc[1]) / abs(revs.iloc[1]) * 100, 1)
        except:
            pass

        total_cash = info.get('totalCash')
        op_expenses = None
        runway_months = None
        quarterly_burn = None
        try:
            quarterly_opex = None
            qinc = t.quarterly_income_stmt
            if qinc is not None and not qinc.empty:
                for row_name in ['Operating Expense', 'Total Operating Expenses', 'OperatingExpense']:
                    if row_name in qinc.index:
                        vals = qinc.loc[row_name].dropna()
                        if len(vals) >= 1:
                            quarterly_opex = float(vals.iloc[0])
                            break
                if quarterly_opex is None:
                    rd_val = 0.0
                    sga_val = 0.0
                    if 'Research And Development' in qinc.index:
                        rd_series = qinc.loc['Research And Development'].dropna()
                        if len(rd_series) >= 1:
                            rd_val = float(rd_series.iloc[0])
                    if 'Selling General And Administration' in qinc.index:
                        sga_series = qinc.loc['Selling General And Administration'].dropna()
                        if len(sga_series) >= 1:
                            sga_val = float(sga_series.iloc[0])
                    if rd_val or sga_val:
                        quarterly_opex = rd_val + sga_val

            if quarterly_opex and quarterly_opex > 0 and total_cash:
                monthly_opex = quarterly_opex / 3
                quarterly_burn = quarterly_opex
                op_expenses = quarterly_opex * 4
                runway_months = round(total_cash / monthly_opex, 1)

            if runway_months is None:
                inc = t.income_stmt
                if inc is not None and not inc.empty:
                    for row_name in ['Operating Expense', 'Total Operating Expenses']:
                        if row_name in inc.index:
                            vals = inc.loc[row_name].dropna()
                            if len(vals) >= 1:
                                op_expenses = float(vals.iloc[0])
                                break
                if total_cash and op_expenses and op_expenses > 0:
                    runway_months = round(total_cash / (op_expenses / 12), 1)
        except:
            pass

        graham_number = None
        pe_fair_value = None
        graham_formula = None
        book_value = info.get('bookValue')
        try:
            eps_ttm = info.get('trailingEps')
            eps_fwd = info.get('forwardEps')
            if book_value and eps_ttm and book_value > 0 and eps_ttm > 0:
                graham_number = round(math.sqrt(22.5 * eps_ttm * book_value), 2)
            if eps_fwd and eps_fwd > 0:
                pe_fair_value = round(eps_fwd * 15, 2)
            if eps_ttm and eps_ttm > 0 and rev_growth is not None:
                g = min(abs(rev_growth), 50)
                graham_formula = round(eps_ttm * (8.5 + 2 * g), 2)
        except:
            pass

        return jsonify({
            'ticker': ticker,
            'name': info.get('longName') or info.get('shortName', ticker),
            'sector': info.get('sector', '—'),
            'industry': info.get('industry', '—'),
            'price': round(price, 2) if price else None,
            'change': change,
            'change_pct': change_pct,
            'pe': round(info['trailingPE'], 1) if info.get('trailingPE') else None,
            'forward_pe': round(info['forwardPE'], 1) if info.get('forwardPE') else None,
            'eps': info.get('trailingEps'),
            'eps_forward': info.get('forwardEps'),
            'beta': round(info['beta'], 2) if info.get('beta') else None,
            'market_cap': info.get('marketCap'),
            'revenue_growth': rev_growth,
            'profit_margin': round(info['profitMargins'] * 100, 1) if info.get('profitMargins') else None,
            'sma200': sma200,
            'above_sma200': above_sma200,
            'atr': atr,
            'total_cash': total_cash,
            'total_debt': info.get('totalDebt'),
            'runway_months': runway_months,
            'analyst_target': info.get('targetMeanPrice'),
            'analyst_low': info.get('targetLowPrice'),
            'analyst_high': info.get('targetHighPrice'),
            'recommendation': info.get('recommendationKey', '—'),
            'num_analysts': info.get('numberOfAnalystOpinions'),
            'fifty_two_week_low': info.get('fiftyTwoWeekLow'),
            'fifty_two_week_high': info.get('fiftyTwoWeekHigh'),
            'dividend_yield': round(info['dividendYield'] * 100, 2) if info.get('dividendYield') else None,
            'short_ratio': info.get('shortRatio'),
            'book_value': book_value,
            'graham_number': graham_number,
            'pe_fair_value': pe_fair_value,
            'graham_formula': graham_formula,
            'quarterly_burn': quarterly_burn,
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/history/<ticker>')
def get_history(ticker):
    try:
        ticker = ticker.upper().strip()
        t = yf.Ticker(ticker)
        hist = t.history(period="1y")
        if hist.empty:
            return jsonify({'error': 'Sin historial disponible'}), 404
        dates = [str(d.date()) for d in hist.index]
        prices = [round(float(p), 2) for p in hist['Close']]
        return jsonify({'ticker': ticker, 'dates': dates, 'prices': prices})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/fundamentals/<ticker>')
def get_fundamentals(ticker):
    try:
        ticker = ticker.upper().strip()
        t = yf.Ticker(ticker)
        result = {'ticker': ticker, 'eps': [], 'revenue': [], 'margins': [], 'pe_history': []}

        try:
            earnings = t.quarterly_earnings
            if earnings is not None and not earnings.empty:
                for date, row in earnings.iterrows():
                    result['eps'].append({
                        'period': str(date),
                        'actual': round(float(row.get('Earnings', 0) or 0), 2),
                        'estimate': round(float(row.get('Estimate', 0) or 0), 2) if row.get('Estimate') else None
                    })
                result['eps'] = list(reversed(result['eps']))[-8:]
        except: pass

        try:
            fin = t.financials
            if fin is not None and not fin.empty:
                for col in fin.columns[:4]:
                    rev = fin.loc['Total Revenue', col] if 'Total Revenue' in fin.index else None
                    net = fin.loc['Net Income', col] if 'Net Income' in fin.index else None
                    gross = fin.loc['Gross Profit', col] if 'Gross Profit' in fin.index else None
                    if rev and rev > 0:
                        result['revenue'].append({
                            'period': str(col.year),
                            'revenue': round(float(rev) / 1e9, 2),
                            'net_income': round(float(net) / 1e9, 2) if net else None,
                            'gross_profit': round(float(gross) / 1e9, 2) if gross else None,
                            'margin': round(float(net) / float(rev) * 100, 1) if net and rev else None,
                            'gross_margin': round(float(gross) / float(rev) * 100, 1) if gross and rev else None,
                        })
                result['revenue'] = list(reversed(result['revenue']))
        except: pass

        try:
            qfin = t.quarterly_financials
            result['quarterly_revenue'] = []
            if qfin is not None and not qfin.empty and 'Total Revenue' in qfin.index:
                for col in list(reversed(qfin.columns))[-8:]:
                    rev = qfin.loc['Total Revenue', col]
                    if rev and rev > 0:
                        result['quarterly_revenue'].append({
                            'period': str(col)[:7],
                            'revenue': round(float(rev) / 1e9, 2)
                        })
        except: pass

        try:
            hist = t.history(period="5y", interval="3mo")
            info = t.info
            eps_ttm = info.get('trailingEps')
            if eps_ttm and not hist.empty:
                prices = hist['Close'].resample('QE').last().dropna()
                for date, price in prices.items():
                    pe = round(float(price) / eps_ttm, 1) if eps_ttm > 0 else None
                    if pe and 0 < pe < 500:
                        result['pe_history'].append({'period': str(date)[:7], 'pe': pe, 'price': round(float(price), 2)})
                result['pe_history'] = result['pe_history'][-12:]
        except: pass

        def sanitize(obj):
            if isinstance(obj, dict): return {k: sanitize(v) for k, v in obj.items()}
            elif isinstance(obj, list): return [sanitize(v) for v in obj]
            elif isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)): return None
            return obj
        result = sanitize(result)
        return jsonify(result)

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/financials/<ticker>')
def get_financials(ticker):
    try:
        ticker = ticker.upper().strip()
        t = yf.Ticker(ticker)
        result = {}

        try:
            qe = t.quarterly_earnings
            if qe is not None and not qe.empty:
                qe = qe.sort_index()
                result['eps_quarterly'] = {
                    'labels': [str(i) for i in qe.index],
                    'reported': [round(float(v),2) if v == v else None for v in qe.get('Reported EPS', qe.iloc[:,0])],
                    'estimated': [round(float(v),2) if v == v else None for v in qe.get('Estimated EPS', qe.iloc[:,0])]
                }
        except: pass

        try:
            fin = t.financials
            if fin is not None and not fin.empty:
                cols = list(fin.columns)
                cols_sorted = sorted(cols)
                labels = [str(c.date()) for c in cols_sorted]
                def get_row(name):
                    if name in fin.index:
                        return [round(float(fin.loc[name, c])/1e9, 2) if fin.loc[name, c] == fin.loc[name, c] else None for c in cols_sorted]
                    return None
                rev = get_row('Total Revenue')
                net = get_row('Net Income')
                gross = get_row('Gross Profit')
                result['annual'] = {'labels': labels, 'revenue': rev, 'net_income': net, 'gross_profit': gross}
        except: pass

        try:
            qfin = t.quarterly_financials
            if qfin is not None and not qfin.empty:
                cols = list(qfin.columns)
                cols_sorted = sorted(cols)[-8:]
                labels = [str(c.date()) for c in cols_sorted]
                def get_qrow(name):
                    if name in qfin.index:
                        return [round(float(qfin.loc[name, c])/1e9, 2) if qfin.loc[name, c] == qfin.loc[name, c] else None for c in cols_sorted]
                    return None
                qrev = get_qrow('Total Revenue')
                qnet = get_qrow('Net Income')
                result['quarterly'] = {'labels': labels, 'revenue': qrev, 'net_income': qnet}
        except: pass

        try:
            hist = t.history(period="2y", interval="1mo")
            info = t.info
            eps_ttm = info.get('trailingEps')
            if hist is not None and not hist.empty and eps_ttm:
                pe_labels = [str(d.date()) for d in hist.index]
                pe_vals = [round(float(p)/eps_ttm, 1) if eps_ttm and eps_ttm > 0 else None for p in hist['Close']]
                result['pe_history'] = {'labels': pe_labels, 'pe': pe_vals}
        except: pass

        try:
            fin2 = t.financials
            if fin2 is not None and not fin2.empty:
                cols = sorted(fin2.columns)
                labels = [str(c.date()) for c in cols]
                margins = []
                for c in cols:
                    try:
                        rev_v = float(fin2.loc['Total Revenue', c])
                        net_v = float(fin2.loc['Net Income', c])
                        margins.append(round(net_v/rev_v*100, 1) if rev_v else None)
                    except: margins.append(None)
                result['margins'] = {'labels': labels, 'net_margin': margins}
        except: pass

        def sanitize(obj):
            if isinstance(obj, dict): return {k: sanitize(v) for k, v in obj.items()}
            elif isinstance(obj, list): return [sanitize(v) for v in obj]
            elif isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)): return None
            return obj
        result = sanitize(result)
        return jsonify(result)

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/batch', methods=['POST'])
def get_batch():
    """Endpoint para heatmap: obtiene precio y cambio % de múltiples tickers a la vez."""
    body = flask_request.get_json(silent=True) or {}
    raw = body.get('tickers', [])
    tickers_list = [str(t).upper().strip() for t in raw if str(t).strip()][:60]
    if not tickers_list:
        return jsonify({})

    results = {t: {'ticker': t, 'price': None, 'change': None, 'change_pct': None, 'market_cap': None, 'name': t} for t in tickers_list}

    # --- Batch price download via yfinance ---
    try:
        joined = ' '.join(tickers_list)
        df = yf.download(joined, period='5d', progress=False, auto_adjust=True)

        if HAS_PANDAS:
            is_multi = hasattr(df.columns, 'levels')
        else:
            is_multi = False

        def get_closes(ticker_sym):
            try:
                if is_multi:
                    if 'Close' in df.columns.get_level_values(0):
                        col_df = df['Close']
                        if hasattr(col_df, 'columns') and ticker_sym in col_df.columns:
                            return col_df[ticker_sym].dropna()
                    if ticker_sym in df.columns.get_level_values(0):
                        return df[ticker_sym]['Close'].dropna()
                else:
                    if len(tickers_list) == 1 and 'Close' in df.columns:
                        return df['Close'].dropna()
            except:
                pass
            return None

        for t in tickers_list:
            try:
                closes = get_closes(t)
                if closes is not None and len(closes) >= 2:
                    price = float(closes.iloc[-1])
                    prev  = float(closes.iloc[-2])
                    if prev > 0:
                        chg  = round(price - prev, 2)
                        chgp = round(chg / prev * 100, 2)
                        results[t].update({'price': round(price, 2), 'change': chg, 'change_pct': chgp})
            except:
                pass
    except:
        traceback.print_exc()

    # --- Market cap + fallback price via fast_info ---
    for t in tickers_list[:30]:
        try:
            fi = yf.Ticker(t).fast_info
            mc = getattr(fi, 'market_cap', None)
            if mc:
                v = clean(mc)
                if v is not None:
                    results[t]['market_cap'] = int(v)
            if results[t]['price'] is None:
                lp = getattr(fi, 'last_price', None)
                pc = getattr(fi, 'previous_close', None)
                if lp and float(lp) > 0:
                    p2 = round(float(lp), 2)
                    results[t]['price'] = p2
                    if pc and float(pc) > 0:
                        chg = round(p2 - float(pc), 2)
                        results[t]['change'] = chg
                        results[t]['change_pct'] = round(chg / float(pc) * 100, 2)
        except:
            pass

    def sanitize(obj):
        if isinstance(obj, dict): return {k: sanitize(v) for k, v in obj.items()}
        if isinstance(obj, list): return [sanitize(v) for v in obj]
        if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)): return None
        return obj

    return jsonify(sanitize(results))


@app.route('/chat', methods=['POST'])
def chat():
    """Proxy hacia Groq API (100% gratis) — API Key en console.groq.com"""
    body = flask_request.get_json(silent=True) or {}
    messages = body.get('messages', [])
    api_key = body.get('api_key', '').strip() or os.environ.get('GROQ_API_KEY', '')
    if not api_key:
        return jsonify({'error': 'API_KEY_MISSING'}), 400
    if not messages:
        return jsonify({'error': 'Sin mensajes'}), 400
    if not HAS_REQUESTS:
        return jsonify({'error': 'pip install requests'}), 500
    full_messages = [{'role': 'system', 'content': CHATBOT_SYSTEM}] + messages[-20:]

    # Auto-detectar proveedor por prefijo de la key
    # sk-...   → OpenAI  (gpt-4o-mini)
    # gsk_...  → Groq    (llama-3.3-70b-versatile — gratis)
    # AIza...  → Google Gemini (gemini-2.0-flash — gratis)
    if api_key.startswith('sk-'):
        url   = 'https://api.openai.com/v1/chat/completions'
        model = 'gpt-4o-mini'
        try:
            resp = http_req.post(url,
                headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
                json={'model': model, 'messages': full_messages, 'max_tokens': 1500, 'temperature': 0.7},
                timeout=30)
            if not resp.ok:
                try: err_msg = resp.json().get('error',{}).get('message', f'HTTP {resp.status_code}')
                except: err_msg = f'HTTP {resp.status_code}'
                return jsonify({'error': err_msg}), resp.status_code
            return jsonify({'content': resp.json()['choices'][0]['message']['content']})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    elif api_key.startswith('AIza') or api_key.startswith('AQ.'):
        # Google Gemini REST API
        gemini_url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={api_key}'
        # Convertir mensajes al formato Gemini
        gemini_contents = []
        for m in messages[-20:]:
            role = 'user' if m['role'] == 'user' else 'model'
            gemini_contents.append({'role': role, 'parts': [{'text': m['content']}]})
        # System prompt como primer turno user/model
        gemini_payload = {
            'system_instruction': {'parts': [{'text': CHATBOT_SYSTEM}]},
            'contents': gemini_contents,
            'generationConfig': {'maxOutputTokens': 1500, 'temperature': 0.7}
        }
        try:
            resp = http_req.post(gemini_url, json=gemini_payload, timeout=30)
            if not resp.ok:
                try: err_msg = resp.json().get('error',{}).get('message', f'HTTP {resp.status_code}')
                except: err_msg = f'HTTP {resp.status_code}'
                return jsonify({'error': err_msg}), resp.status_code
            data = resp.json()
            text = data['candidates'][0]['content']['parts'][0]['text']
            return jsonify({'content': text})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    else:
        # Groq por defecto
        url = 'https://api.groq.com/openai/v1/chat/completions'
        model = 'llama-3.3-70b-versatile'
        try:
            resp = http_req.post(url,
                headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
                json={'model': model, 'messages': full_messages, 'max_tokens': 1500, 'temperature': 0.7},
                timeout=30)
            if not resp.ok:
                try: err_msg = resp.json().get('error',{}).get('message', f'HTTP {resp.status_code}')
                except: err_msg = f'HTTP {resp.status_code}'
                return jsonify({'error': err_msg}), resp.status_code
            return jsonify({'content': resp.json()['choices'][0]['message']['content']})
        except Exception as e:
            return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5050))
    is_local = port == 5050
    if is_local:
        print("\n" + "="*50)
        print("  MarketIntel — Servidor iniciado")
        print("  Abre tu navegador en:")
        print("  http://localhost:5050")
        print("="*50 + "\n")
    app.run(host='0.0.0.0', port=port, debug=False)
