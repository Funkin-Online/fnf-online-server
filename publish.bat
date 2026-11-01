@echo off
REM Rebuilds the HTML5 game, refreshes docs\ (GitHub Pages + the Render host)
REM and pushes. Render redeploys itself; Pages republishes from docs\.
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

cd /d "%~dp0"
echo.
echo Rebuilding docs\...
node tools\build-docs.js
if errorlevel 1 (
  echo.
  echo docs\ rebuild FAILED.
  pause
  exit /b 1
)

echo.
echo Committing and pushing...
git add -A
git commit -m "Update web build"
git push

echo.
echo Done. Render redeploys on this push; Pages republishes docs\ shortly.
echo   Render: https://fnf-online-server.onrender.com
echo   Pages:  https://funkin-online.github.io/fnf-online-server/
pause
