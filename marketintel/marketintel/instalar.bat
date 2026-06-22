@echo off
echo.
echo ================================================
echo   MarketIntel - Instalando dependencias...
echo ================================================
echo.
pip install flask flask-cors yfinance requests gunicorn
echo.
echo ================================================
echo   Instalacion completada!
echo   Ahora ejecuta: INICIAR.bat
echo ================================================
pause
