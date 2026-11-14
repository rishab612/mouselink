@echo off
setlocal
cd /d "%~dp0"
start "MouseLink host" /D "%~dp0" py -3 server.py
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8765"
endlocal
