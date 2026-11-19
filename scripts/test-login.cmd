@echo off
cd /d "%~dp0.."
set "EP=%CD%\test-endpoint"
if not exist "%EP%" mkdir "%EP%"
if not exist "%EP%\desktop-oauth.json" copy /Y "resources\desktop-oauth.example.json" "%EP%\desktop-oauth.json" >nul
if not exist "%EP%\config.json" copy /Y "resources\provider.example.json" "%EP%\config.json" >nul
echo Starting Google Gemini (Robin) OAuth Login...
echo.
node --experimental-strip-types src/login.ts "%EP%"
echo.
pause
