@echo off
title Firewall Opener
echo Requesting Administrator privileges...
powershell -Command "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -Command New-NetFirewallRule -DisplayName \"FNF Online Server\" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow' -Verb RunAs"
echo.
echo If you saw a popup, click YES.
echo The port 8080 is now open for your friends to join.
pause