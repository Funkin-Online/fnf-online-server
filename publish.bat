@echo off
REM Rebuilds the HTML5 game, refreshes docs\ (GitHub Pages and the Render host)
REM and pushes. Render redeploys itself; Pages republishes docs\.
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
echo [1/3] Building HTML5...
haxelib run lime build html5 -debug
if errorlevel 1 (
  echo.
  echo BUILD FAILED - scroll up for the Haxe errors.
  pause
  exit /b 1
)

cd /d "%~dp0"
echo.
echo [2/3] Rebuilding docs\ (chooser + keyboard + touch pages)...
node tools\build-docs.js
if errorlevel 1 (
  echo.
  echo docs\ rebuild FAILED.
  pause
  exit /b 1
)

echo.
echo [3/3] Committing and pushing...
git add -A
git commit -m "Update web build"
git push

echo.
echo Done. Render redeploys on this push; Pages republishes docs\ shortly.
echo   Pages:  https://funkin-online.github.io/fnf-online-server/
echo   Render: https://fnf-online-server.onrender.com
pause
