@echo off
chcp 65001 >nul
title WhatsApp Mesaj Gonderici
cd /d "%~dp0"

echo ================================================
echo  WhatsApp Mesaj Gonderici - http://localhost:3000
echo ================================================
echo.
echo  [1] Tarayici modunda ac (web)
echo  [2] Masaustu programi olarak ac (Electron)
echo.
set /p mode="Seciminiz (1/2): "

where node >nul 2>nul
if errorlevel 1 goto no_node
echo [OK] Node.js bulundu.

if exist "node_modules" goto kill_port
echo [*] Bagimliliklar yukleniyor...
npm install
if errorlevel 1 goto npm_fail
echo [OK] Kurulum tamam.

:kill_port
echo [*] Port 3000 kontrol ediliyor...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr /R ":3000 "') do taskkill /F /PID %%a >nul 2>nul
timeout /t 1 /nobreak >nul

if "%mode%"=="2" goto electron

:run
echo.
echo ================================================
echo  Tarayicinizda acin: http://localhost:3000
echo  Durdurmak icin CTRL+C
echo ================================================
echo.
node server.js
echo.
echo [!] Sunucu kapandi.
echo.
pause
goto :eof

:electron
echo.
echo [*] Electron kontrol ediliyor...
if not exist "node_modules\electron" (
    echo [*] Electron yukleniyor...
    npm install electron electron-builder --save-dev
    if errorlevel 1 (
        echo [HATA] Electron yuklenemedi!
        echo Tarayici moduna geciliyor...
        goto run
    )
)
echo ================================================
echo  Masaustu program baslatiliyor...
echo  Durdurmak icin pencereyi kapatin
echo ================================================
echo.
npx electron .
echo.
echo [!] Program kapandi.
echo.
pause
goto :eof

:no_node
echo [HATA] Node.js bulunamadi!
echo https://nodejs.org adresinden LTS surumunu indirip kurun.
echo.
pause
goto :eof

:npm_fail
echo [HATA] npm install basarisiz oldu!
echo.
pause
goto :eof
