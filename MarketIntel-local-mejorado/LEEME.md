# MarketIntel local mejorado

En Windows, haz doble clic en `INICIAR.bat`. La aplicación abrirá `http://localhost:5050`.

También puedes iniciarla manualmente:

```bash
python -m pip install -r requirements.txt
python servidor.py
```

Las cotizaciones, históricos y fundamentales continúan llegando desde Yahoo Finance mediante `yfinance`. MarketBot conserva soporte para Groq, OpenAI y Gemini. Portafolios, transacciones, watchlists, notas y preferencias se guardan localmente en el navegador.

Desde **Personalizar** puedes exportar o importar una copia de tus datos locales.

## Carga automática

`INICIAR.bat` espera brevemente a que el servidor esté listo antes de abrir el navegador. **Pulso macro** consulta sus ocho series de FRED en paralelo, comparte una sola solicitud entre la sección y la barra superior, reintenta automáticamente y vuelve a comprobar los datos cuando recuperas la conexión o regresas a la pestaña. No debes presionar F5 para que aparezcan.

La barra superior y el portafolio solicitan las cotizaciones en grupos para reducir llamadas repetidas a Yahoo Finance. Si Yahoo limita temporalmente las consultas, MarketIntel conserva los últimos precios visibles y permite reintentar sin perder posiciones, operaciones ni formularios.

## Portafolio estilo broker

El portafolio usa las transacciones como libro contable y conserva automáticamente las posiciones creadas con versiones anteriores. Ahora permite registrar:

- Compras, ventas parciales o totales, posiciones cortas y coberturas.
- Depósitos, retiros, dividendos y comisiones.
- Efectivo inicial para cada cuenta.

El resumen separa valor neto liquidativo, efectivo, poder de compra sin margen, P&L diario, P&L realizado y P&L no realizado. El precio promedio incorpora las comisiones de compra; las comisiones de venta se descuentan del resultado realizado.

El gráfico histórico respeta la fecha de cada operación: una posición no aparece antes de su compra. La cuenta también puede compararse con S&P 500 y Nasdaq 100.

Usa **Exportar CSV** para descargar el historial de movimientos. **Copia de cuenta** crea un archivo JSON que puede importarse en otra computadora sin reemplazar las cuentas existentes. Las API keys no forman parte de esa copia.

## Fuentes de datos opcionales

La app funciona sin claves adicionales. Yahoo Finance sigue siendo la fuente base y nunca se elimina. Si la pantalla muestra **“Opcional · sin configurar”**, no es un error: esa fuente adicional todavía no tiene sus datos de acceso.

La forma más sencilla de configurarlas en Windows es:

1. Cierra MarketIntel.
2. Haz doble clic en `CONFIGURAR_APIS.bat`.
3. Pega las claves que tengas y escribe tu correo real para SEC.
4. Abre nuevamente `INICIAR.bat`.

También puedes configurarlas manualmente:

1. Duplica `.env.example` y renómbralo `.env`.
2. Completa solamente las claves que quieras usar.
3. Reinicia `INICIAR.bat`.

- `FMP_API_KEY`: Financial Modeling Prep para ratios, fundamentales y estimaciones normalizadas. Si un dato no existe en Yahoo, puede completar esa métrica avanzada.
- `FRED_API_KEY`: Federal Reserve Economic Data para la tasa FED y otros indicadores macro oficiales.
- `SEC_USER_AGENT`: nombre de la app y tu correo. SEC EDGAR **no necesita API key**, pero exige un User-Agent identificable. El asistente lo crea con el correo que escribas.

Las claves se leen únicamente en `servidor.py`; nunca se envían ni se guardan en el HTML. Si una integración falla, MarketIntel muestra su estado y conserva los datos de Yahoo Finance.

Para proteger las cuotas, FMP y SEC solo se consultan al abrir una **Ficha Técnica** con auditoría. El ticker superior, el dashboard y las listas continúan usando Yahoo Finance y no consumen llamadas complementarias.

Documentación oficial:

- FMP: https://site.financialmodelingprep.com/developer/docs
- FRED: https://fred.stlouisfed.org/docs/api/fred/
- SEC EDGAR: https://www.sec.gov/search-filings/edgar-application-programming-interfaces

## Auditoría financiera

La Ficha Técnica incluye dos paneles desplegables:

- **Métricas financieras avanzadas**: márgenes, ROA, ROE, P/B, PEG, EV/Revenue, EV/EBITDA, P/FCF, ratio corriente, flujo de caja, I+D, acciones, D/E normalizado e historial anual/trimestral.
- **Auditoría y fuentes**: muestra el valor recibido, valor calculado, fórmula, periodo, fuente y actualización de cada métrica. También verifica `Market Cap ≈ precio × acciones`, `P/E ≈ precio ÷ EPS`, `margen neto ≈ ganancia neta ÷ ingresos` y `Revenue TTM = suma de cuatro trimestres`.

Las etiquetas `TTM`, `Forward`, `FY`, `Q`, `Estimado`, `14D` y `200D` aclaran el periodo o tipo de cada dato.

Cada alerta de auditoría significa “revisar”, no necesariamente “dato incorrecto”: dos proveedores pueden usar periodos, acciones diluidas o definiciones de deuda distintas.

## Controles visuales

- Usa el botón de líneas en la barra superior para activar o desactivar el **modo compacto**. Atajo: `Alt + C`.
- Las herramientas secundarias —comparación, presentación, densidad y tema— están agrupadas en el botón de **tres puntos** de la cabecera.
- En **Personalizar → Escala visual** puedes elegir `Pequeña`, `Normal` o `Grande` sin cambiar la cantidad de información mostrada.
- Usa el botón de ampliar de cada gráfico para abrir el **modo enfoque**. Presiona `Esc` para salir.
- El gráfico del screener permite cambiar entre `1M`, `6M`, `1A` y `5A`.
- En móvil, las tablas se convierten automáticamente en tarjetas legibles.
- El botón **Comparar** permite revisar hasta tres acciones lado a lado.
- En **Personalizar → Organizar**, puedes arrastrar paneles y cambiar su ancho. Fuera de ese modo, el dashboard permanece bloqueado.
- En el portafolio puedes elegir las columnas visibles.
- El modo **Presentación** oculta los controles secundarios. Atajo: `Shift + P`.

El runway conserva la fórmula original: **Cash total ÷ (Operating Expenses anuales ÷ 12)**. Los datos de flujo de caja trimestral siguen disponibles en la API y no se eliminó ninguna conexión con Yahoo Finance. Si Yahoo Finance no publica una métrica, la interfaz indica **No disponible**.

El D/E se muestra como ratio (`3.89x`, por ejemplo), el dividend yield se normaliza para evitar mostrar `167%` cuando la fuente significa `1.67%`, y el crecimiento negativo de la fórmula de Graham se limita a `0%`; nunca se convierte en crecimiento positivo.

## Autorrellenado de valuación

Al cargar un ticker, MarketIntel estima el **Market Cap futuro** y lo coloca en las dos calculadoras del Principio 01. Prioriza la fórmula **EPS Forward × P/E objetivo × acciones en circulación**; si esos datos no están disponibles, intenta una proyección por Revenue y P/S o, como último recurso, el consenso de analistas. La interfaz siempre indica qué método utilizó.

La proyección es editable. Al cambiarla, ambas calculadoras se sincronizan y aplican tu fórmula original: **Price Target = Precio actual × (Market Cap futuro ÷ Market Cap presente)**. El upside/downside es la diferencia porcentual real entre ese Price Target y el precio actual.

Variables opcionales: `PORT`, `MARKETINTEL_CACHE_TTL`, `MARKETINTEL_ALLOWED_ORIGINS`, `FMP_API_KEY`, `FRED_API_KEY` y `SEC_USER_AGENT`.
