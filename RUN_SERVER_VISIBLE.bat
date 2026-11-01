@echo off
title FNF Online Server
echo Starting Multiplayer Server...
echo Tip: If other devices on your Wi-Fi cannot connect, run OPEN_FIREWALL.bat once!
echo.
cd /d "%~dp0server"
node server.js
pause