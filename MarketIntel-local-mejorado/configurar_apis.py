"""Asistente local para guardar las integraciones opcionales en .env."""

from getpass import getpass
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / '.env'
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')


def read_lines():
    if not ENV_PATH.exists():
        return [
            '# Configuración local de MarketIntel\n',
            '# No compartas este archivo ni lo subas a GitHub.\n',
            '\n',
        ]
    return ENV_PATH.read_text(encoding='utf-8').splitlines(keepends=True)


def set_value(lines, key, value):
    prefix = f'{key}='
    replacement = f'{prefix}{value}\n'
    for index, line in enumerate(lines):
        if line.strip().startswith(prefix):
            lines[index] = replacement
            return
    if lines and not lines[-1].endswith('\n'):
        lines[-1] += '\n'
    lines.append(replacement)


def main():
    print()
    print('CONFIGURACIÓN DE APIS OPCIONALES — MARKETINTEL')
    print('Yahoo Finance funciona aunque dejes todo vacío.')
    print('Presiona Enter para conservar una configuración existente.')
    print()

    lines = read_lines()
    fmp_key = getpass('FMP API key (oculta al escribir): ').strip()
    fred_key = getpass('FRED API key (opcional, oculta al escribir): ').strip()
    sec_email = input('Correo real para identificar MarketIntel ante SEC: ').strip()

    if sec_email and not EMAIL_RE.fullmatch(sec_email):
        print()
        print('El correo de SEC no parece válido. No se modificó esa opción.')
        sec_email = ''

    if fmp_key:
        set_value(lines, 'FMP_API_KEY', fmp_key)
    if fred_key:
        set_value(lines, 'FRED_API_KEY', fred_key)
    if sec_email:
        set_value(
            lines,
            'SEC_USER_AGENT',
            f'MarketIntel-local/1.0 {sec_email}',
        )

    if not ENV_PATH.exists():
        set_value(lines, 'MARKETINTEL_CACHE_TTL', '120')
        set_value(
            lines,
            'MARKETINTEL_ALLOWED_ORIGINS',
            'http://localhost:5050,http://127.0.0.1:5050',
        )

    ENV_PATH.write_text(''.join(lines), encoding='utf-8')
    print()
    print('Configuración guardada localmente en .env.')
    print('Cierra y vuelve a abrir MarketIntel para aplicar los cambios.')


if __name__ == '__main__':
    main()
