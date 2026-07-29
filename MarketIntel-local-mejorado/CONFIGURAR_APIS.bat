@echo off
setlocal
cd /d "%~dp0"
title Configurar APIs de MarketIntel
where py >nul 2>&1
if %errorlevel%==0 (set "PYTHON=py") else (set "PYTHON=python")
%PYTHON% configurar_apis.py
echo.
pause
endlocal
