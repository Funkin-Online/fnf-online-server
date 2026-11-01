@echo off
REM Builds Funkin Online for the browser (HTML5) into game\export\debug\
REM Double-click this, or run it from a terminal.
setlocal

set "PATH=C:\HaxeToolkit\haxe;C:\HaxeToolkit\neko;%PATH%"
cd /d "%~dp0game"

REM The online button art lives outside the assets submodule so it never gets
REM wiped by a submodule update. Put it back if it is missing.
if not exist "assets\images\mainmenu\online.png" (
  if exist "..\online-art-backup\images\mainmenu\online.png" (
    echo Copying online button art into assets...
    if not exist "assets\images\mainmenu" mkdir "assets\images\mainmenu"
    copy /Y "..\online-art-backup\images\mainmenu\online.png" "assets\images\mainmenu\" >nul
    copy /Y "..\online-art-backup\images\mainmenu\online.xml" "assets\images\mainmenu\" >nul
  )
)

echo.
echo Building HTML5 (debug)...
haxelib run lime build html5 -debug
if errorlevel 1 (
  echo.
  echo BUILD FAILED - scroll up for the Haxe errors.
  pause
  exit /b 1
)

echo.
echo Build OK: game\export\debug\html5\bin\index.html
echo.
echo Tip: Start the server with RUN_SERVER_VISIBLE.bat or start-server.bat,
echo then open http://localhost:8080/ in your browser to play!
echo.
pause
