const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const https = require('https');

let mainWindow;
let splashWindow;
let isUpdating = false;
const appDir = path.dirname(process.execPath).includes('electron')
    ? __dirname
    : path.dirname(process.execPath);
const resourceDir = __dirname; // asar içindeki dosyalar

// ─── Veri dizini (ASAR dışında yazılabilir alan) ────────────────────────────
// Portable EXE ve normal mod için yazılabilir veri dizini hesapla

function getPortableDataDir() {
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
        const dataDir = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'whatsapp-sender-data');
        if (!fs.existsSync(dataDir)) {
            try { fs.mkdirSync(dataDir, { recursive: true }); } catch(e) {}
        }
        return dataDir;
    }
    if (process.resourcesPath && __dirname.includes('.asar')) {
        const dataDir = path.join(path.dirname(process.execPath), 'whatsapp-sender-data');
        if (!fs.existsSync(dataDir)) {
            try { fs.mkdirSync(dataDir, { recursive: true }); } catch(e) {}
        }
        return dataDir;
    }
    return __dirname;
}

const DATA_DIR = getPortableDataDir();
const CHROMIUM_DIR = path.join(DATA_DIR, 'chromium');

// ─── Splash Screen (gereksinim kontrolü) ────────────────────────────────────

function createSplashWindow() {
    splashWindow = new BrowserWindow({
        width: 520,
        height: 420,
        frame: false,
        resizable: false,
        transparent: true,
        alwaysOnTop: true,
        backgroundColor: '#00000000',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    const splashHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Segoe UI',sans-serif;background:transparent;color:#e0e0e8;overflow:hidden;-webkit-app-region:drag;}
.card{background:linear-gradient(135deg,#0d0d1a 0%,#1a1a2e 100%);border:1px solid rgba(139,92,246,0.3);border-radius:16px;padding:32px;width:100%;height:100vh;display:flex;flex-direction:column;align-items:center;box-shadow:0 20px 60px rgba(0,0,0,0.6);}
h1{font-size:20px;color:#a78bfa;margin-bottom:4px;}
.sub{font-size:12px;color:#888;margin-bottom:24px;}
.checks{width:100%;flex:1;overflow-y:auto;}
.item{display:flex;align-items:center;gap:10px;padding:8px 12px;margin-bottom:6px;border-radius:8px;background:rgba(255,255,255,0.03);font-size:13px;}
.item .icon{font-size:18px;min-width:24px;text-align:center;}
.item .name{flex:1;}
.item .status{font-size:11px;font-weight:700;padding:2px 10px;border-radius:10px;}
.ok{background:rgba(16,185,129,0.15);color:#10b981;}
.fail{background:rgba(239,68,68,0.15);color:#ef4444;}
.wait{background:rgba(245,158,11,0.15);color:#f59e0b;}
.load{background:rgba(139,92,246,0.15);color:#a78bfa;}
.btn-row{margin-top:16px;display:flex;gap:10px;width:100%;-webkit-app-region:no-drag;}
.btn{flex:1;padding:10px;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;transition:all 0.2s;}
.btn-primary{background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;}
.btn-primary:hover{opacity:0.85;}
.btn-primary:disabled{opacity:0.4;cursor:not-allowed;}
.btn-ghost{background:rgba(255,255,255,0.06);color:#aaa;border:1px solid rgba(255,255,255,0.1);}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(167,139,250,0.3);border-top-color:#a78bfa;border-radius:50%;animation:spin 0.8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}
.log{margin-top:8px;font-size:10px;color:#666;max-height:40px;overflow-y:auto;width:100%;text-align:center;line-height:1.5;}
</style></head>
<body><div class="card">
<h1>WhatsApp Mesaj G\u00f6ndericisi</h1>
<div class="sub">Gereksinimler kontrol ediliyor...</div>
<div class="checks" id="checks"></div>
<div class="log" id="log"></div>
<div class="btn-row">
    <button class="btn btn-ghost" id="btn-cancel" onclick="require('electron').ipcRenderer.send('splash-cancel')">Kapat</button>
    <button class="btn btn-primary" id="btn-install" disabled onclick="require('electron').ipcRenderer.send('splash-install')">Y\u00fckle ve Ba\u015flat</button>
</div>
</div>
<script>
const { ipcRenderer } = require('electron');
ipcRenderer.on('check-result', (e, data) => {
    const el = document.getElementById('chk-' + data.id);
    if (el) {
        el.querySelector('.icon').textContent = data.ok ? '\u2705' : (data.installing ? '\u23F3' : '\u274C');
        const st = el.querySelector('.status');
        st.textContent = data.statusText;
        st.className = 'status ' + (data.ok ? 'ok' : (data.installing ? 'load' : 'fail'));
    }
});
ipcRenderer.on('add-check', (e, data) => {
    const div = document.createElement('div');
    div.className = 'item'; div.id = 'chk-' + data.id;
    div.innerHTML = '<span class="icon"><div class="spinner"></div></span><span class="name">' + data.name + '</span><span class="status wait">Kontrol ediliyor</span>';
    document.getElementById('checks').appendChild(div);
});
ipcRenderer.on('all-ok', () => {
    document.querySelector('.sub').textContent = 'T\u00fcm gereksinimler haz\u0131r!';
    document.getElementById('btn-install').textContent = '\u2705 Ba\u015flat\u0131l\u0131yor...';
    document.getElementById('btn-install').disabled = true;
});
ipcRenderer.on('needs-install', () => {
    document.querySelector('.sub').textContent = 'Eksik gereksinimler var \u2014 y\u00fcklemek i\u00e7in t\u0131klay\u0131n';
    document.getElementById('btn-install').disabled = false;
    document.getElementById('btn-install').textContent = '\u2B07 Y\u00fckle ve Ba\u015flat';
});
ipcRenderer.on('installing', () => {
    document.querySelector('.sub').textContent = 'Y\u00fckleniyor, l\u00fctfen bekleyin...';
    document.getElementById('btn-install').disabled = true;
    document.getElementById('btn-install').textContent = '\u23F3 Y\u00fckleniyor...';
});
ipcRenderer.on('install-log', (e, msg) => {
    const log = document.getElementById('log');
    log.textContent = msg;
});
ipcRenderer.on('install-done', () => {
    document.querySelector('.sub').textContent = 'Y\u00fckleme tamamland\u0131! Ba\u015flat\u0131l\u0131yor...';
});
ipcRenderer.on('install-error', (e, msg) => {
    document.querySelector('.sub').textContent = 'Hata: ' + msg;
    document.getElementById('btn-install').disabled = false;
    document.getElementById('btn-install').textContent = '\u2B07 Tekrar Dene';
});
ipcRenderer.on('update-info', (e, msg) => {
    document.querySelector('.sub').textContent = msg;
});
</script>
</body></html>`;

    splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml));
}

// ─── Chromium kalıcı dizinde arama ──────────────────────────────────────────

function findChromeExeInDir(dir) {
    if (!fs.existsSync(dir)) return null;
    // Recursive olarak chrome.exe veya chromium.exe ara
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && (entry.name === 'chrome.exe' || entry.name === 'chromium.exe')) {
                return fullPath;
            }
            if (entry.isDirectory()) {
                const found = findChromeExeInDir(fullPath);
                if (found) return found;
            }
        }
    } catch(e) {}
    return null;
}

// ─── Gereksinim kontrolleri ─────────────────────────────────────────────────

function checkNodeModules() {
    const nmDir = path.join(resourceDir, 'node_modules');
    return fs.existsSync(nmDir) && fs.existsSync(path.join(nmDir, 'express'));
}

function checkChromium() {
    // 1) DATA_DIR/chromium dizininde kalıcı chrome.exe ara
    const bundledChrome = findChromeExeInDir(CHROMIUM_DIR);
    if (bundledChrome) return true;

    // 2) Puppeteer cache dizinleri (eski kurulum kalıntısı)
    try {
        const puppeteer = require('puppeteer');
        const execPath = puppeteer.executablePath();
        if (fs.existsSync(execPath)) return true;
    } catch(e) {}

    const cacheDir = path.join(resourceDir, 'node_modules', 'puppeteer', '.local-chromium');
    if (fs.existsSync(cacheDir)) return true;

    const cacheDir2 = path.join(resourceDir, '.cache', 'puppeteer');
    if (fs.existsSync(cacheDir2)) return true;

    // 3) Sistemde Chrome var mı?
    return !!findSystemChromePath();
}

function findSystemChromePath() {
    const paths = [
        process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of paths) {
        if (p && fs.existsSync(p)) return p;
    }
    return null;
}

function getChromePath() {
    // Önce DATA_DIR/chromium'da ara (kalıcı indirme)
    const bundledChrome = findChromeExeInDir(CHROMIUM_DIR);
    if (bundledChrome) return bundledChrome;

    // Puppeteer'ın kendi cache'i
    try {
        const puppeteer = require('puppeteer');
        const execPath = puppeteer.executablePath();
        if (fs.existsSync(execPath)) return execPath;
    } catch(e) {}

    // Sistem Chrome
    return findSystemChromePath();
}

async function runChecks() {
    const checks = [
        { id: 'node_modules', name: 'Node Modülleri (express, socket.io, whatsapp-web.js)', check: checkNodeModules },
        { id: 'chromium', name: 'Chromium / Google Chrome (WhatsApp Web için)', check: checkChromium },
    ];

    let allOk = true;
    const results = {};

    for (const c of checks) {
        splashWindow.webContents.send('add-check', { id: c.id, name: c.name });
    }

    // Kısa gecikme — UI'nin render olması için
    await new Promise(r => setTimeout(r, 500));

    for (const c of checks) {
        await new Promise(r => setTimeout(r, 300));
        const ok = c.check();
        results[c.id] = ok;
        if (!ok) allOk = false;
        splashWindow.webContents.send('check-result', {
            id: c.id,
            ok,
            statusText: ok ? 'Hazır' : 'Eksik'
        });
    }

    if (allOk) {
        splashWindow.webContents.send('all-ok');
        // Güncelleme kontrolü (arka planda)
        checkForUpdates();
        await new Promise(r => setTimeout(r, 1000));
        launchApp();
    } else {
        splashWindow.webContents.send('needs-install');
    }
}

// ─── Chromium'u DATA_DIR'e indir (kalıcı) ──────────────────────────────────

async function downloadChromiumToDataDir() {
    if (!fs.existsSync(CHROMIUM_DIR)) fs.mkdirSync(CHROMIUM_DIR, { recursive: true });

    // Chromium for Testing API'sinden en son stable sürümü al
    splashWindow.webContents.send('install-log', 'Chromium sürümü tespit ediliyor...');

    let downloadUrl;
    try {
        const versionsJson = await httpGetString('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json');
        const versions = JSON.parse(versionsJson);
        const stableDownloads = versions.channels.Stable.downloads.chrome;
        const win64 = stableDownloads.find(d => d.platform === 'win64');
        if (win64) {
            downloadUrl = win64.url;
        }
    } catch(e) {
        console.log('[Chromium] Versiyon API hatası:', e.message);
    }

    // Fallback URL (Chromium for Testing)
    if (!downloadUrl) {
        downloadUrl = 'https://storage.googleapis.com/chrome-for-testing-public/131.0.6778.85/win64/chrome-win64.zip';
    }

    splashWindow.webContents.send('install-log', 'Chromium indiriliyor (~150MB)...');

    const zipPath = path.join(CHROMIUM_DIR, 'chrome.zip');

    // İndirme
    await new Promise((resolve, reject) => {
        downloadFile(downloadUrl, zipPath, (pct, mbDone) => {
            splashWindow?.webContents?.send('install-log', `Chromium indiriliyor... %${pct} (${mbDone}MB)`);
        }).then(resolve).catch(reject);
    });

    // ZIP'i aç
    splashWindow.webContents.send('install-log', 'Chromium dosyaları çıkartılıyor...');

    // PowerShell ile zip aç (Windows native)
    await new Promise((resolve, reject) => {
        exec(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${CHROMIUM_DIR}' -Force"`, {
            timeout: 120000
        }, (err) => {
            if (err) reject(new Error('ZIP açılamadı: ' + err.message));
            else resolve();
        });
    });

    // Zip dosyasını sil
    try { fs.unlinkSync(zipPath); } catch(e) {}

    // chrome.exe'yi doğrula
    const chromePath = findChromeExeInDir(CHROMIUM_DIR);
    if (!chromePath) {
        throw new Error('Chromium indirildi ama chrome.exe bulunamadı');
    }

    return chromePath;
}

function httpGetString(url) {
    return new Promise((resolve, reject) => {
        const doRequest = (reqUrl) => {
            const mod = reqUrl.startsWith('https') ? https : require('http');
            mod.get(reqUrl, { timeout: 15000 }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return doRequest(res.headers.location);
                }
                if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve(data));
            }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
        };
        doRequest(url);
    });
}

function downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
        const doDownload = (reqUrl) => {
            const mod = reqUrl.startsWith('https') ? https : require('http');
            const file = fs.createWriteStream(dest);
            mod.get(reqUrl, { timeout: 300000 }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    file.close();
                    try { fs.unlinkSync(dest); } catch(e) {}
                    return doDownload(res.headers.location);
                }
                if (res.statusCode !== 200) { file.close(); res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
                const total = parseInt(res.headers['content-length'] || '0', 10);
                let downloaded = 0;
                res.on('data', chunk => {
                    downloaded += chunk.length;
                    if (total > 0 && onProgress) {
                        const pct = Math.round(downloaded / total * 100);
                        const mb = Math.round(downloaded / 1024 / 1024);
                        onProgress(pct, mb);
                    }
                });
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
            }).on('error', e => { file.close(); reject(e); }).on('timeout', function() { this.destroy(); reject(new Error('Download timeout')); });
        };
        doDownload(url);
    });
}

// ─── Eksik bağımlılıkları yükle ────────────────────────────────────────────

async function installDependencies() {
    splashWindow.webContents.send('installing');

    try {
        // 1) node_modules eksikse npm install
        if (!checkNodeModules()) {
            splashWindow.webContents.send('check-result', {
                id: 'node_modules', ok: false, installing: true, statusText: 'Yükleniyor...'
            });
            splashWindow.webContents.send('install-log', 'npm install çalıştırılıyor...');

            await new Promise((resolve, reject) => {
                const proc = exec('npm install --production', {
                    cwd: resourceDir,
                    timeout: 300000
                }, (err) => {
                    if (err) reject(new Error('npm install başarısız: ' + err.message));
                    else resolve();
                });
                proc.stdout?.on('data', d => {
                    splashWindow?.webContents?.send('install-log', d.toString().trim().substring(0, 80));
                });
            });

            splashWindow.webContents.send('check-result', {
                id: 'node_modules', ok: true, statusText: 'Yüklendi ✓'
            });
        }

        // 2) Chromium eksikse — önce sistem Chrome ara, yoksa DATA_DIR'e indir (KALICI)
        if (!checkChromium()) {
            const sysChrome = findSystemChromePath();
            if (sysChrome) {
                // Chrome bulundu — PUPPETEER_EXECUTABLE_PATH ayarla
                process.env.PUPPETEER_EXECUTABLE_PATH = sysChrome;
                splashWindow.webContents.send('check-result', {
                    id: 'chromium', ok: true, statusText: 'Chrome bulundu ✓'
                });
            } else {
                splashWindow.webContents.send('check-result', {
                    id: 'chromium', ok: false, installing: true, statusText: 'Chromium indiriliyor...'
                });

                try {
                    const chromePath = await downloadChromiumToDataDir();
                    process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
                    splashWindow.webContents.send('check-result', {
                        id: 'chromium', ok: true, statusText: 'İndirildi ✓ (kalıcı)'
                    });
                } catch(dlErr) {
                    console.error('[Chromium] İndirme hatası:', dlErr.message);
                    // Fallback: npx ile dene
                    splashWindow.webContents.send('install-log', 'Alternatif yöntem deneniyor...');
                    await new Promise((resolve, reject) => {
                        exec(`npx puppeteer browsers install chrome --path "${CHROMIUM_DIR}"`, {
                            cwd: resourceDir,
                            timeout: 600000
                        }, (err) => {
                            if (err) reject(new Error('Chromium indirilemedi: ' + err.message));
                            else resolve();
                        });
                    });

                    const chromePath = findChromeExeInDir(CHROMIUM_DIR);
                    if (chromePath) {
                        process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
                    }

                    splashWindow.webContents.send('check-result', {
                        id: 'chromium', ok: true, statusText: 'İndirildi ✓'
                    });
                }
            }
        }

        splashWindow.webContents.send('install-done');
        // Güncelleme kontrolü
        checkForUpdates();
        await new Promise(r => setTimeout(r, 1000));
        launchApp();
    } catch (err) {
        splashWindow.webContents.send('install-error', err.message);
    }
}

// ─── GitHub Otomatik Güncelleme ─────────────────────────────────────────────

function checkForUpdates() {
    try {
        const { autoUpdater } = require('electron-updater');

        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;

        autoUpdater.on('checking-for-update', () => {
            console.log('[Updater] Güncelleme kontrol ediliyor...');
        });

        autoUpdater.on('update-available', (info) => {
            console.log('[Updater] Güncelleme mevcut:', info.version);
            if (splashWindow && !splashWindow.isDestroyed()) {
                splashWindow.webContents.send('update-info', `Güncelleme mevcut: v${info.version} — İndiriliyor...`);
            }
        });

        autoUpdater.on('download-progress', (progress) => {
            const pct = Math.round(progress.percent);
            console.log('[Updater] İndiriliyor... %' + pct);
            if (splashWindow && !splashWindow.isDestroyed()) {
                splashWindow.webContents.send('install-log', `Güncelleme indiriliyor... %${pct}`);
            }
        });

        autoUpdater.on('update-downloaded', (info) => {
            console.log('[Updater] Güncelleme indirildi:', info.version);
            if (splashWindow && !splashWindow.isDestroyed()) {
                splashWindow.webContents.send('update-info', `v${info.version} indirildi — Yeniden başlatılacak...`);
            }
            // 3 saniye bekle sonra kur
            setTimeout(() => {
                isUpdating = true; // Kapanma onay dialogunu atla
                autoUpdater.quitAndInstall(false, true);
            }, 3000);
        });

        autoUpdater.on('update-not-available', () => {
            console.log('[Updater] Güncelleme yok, son sürüm.');
        });

        autoUpdater.on('error', (err) => {
            console.log('[Updater] Güncelleme hatası:', err.message);
            // Güncelleme hatası kritik değil, devam et
        });

        autoUpdater.checkForUpdatesAndNotify();
    } catch(e) {
        // electron-updater yüklü değilse veya portable modda sessizce geç
        console.log('[Updater] Güncelleme kontrolü atlandı:', e.message);
    }
}

// ─── Ana uygulamayı başlat ──────────────────────────────────────────────────

function launchApp() {
    // Chrome path'i varsa ortam değişkenine ata (whatsapp-web.js Puppeteer'a iletilir)
    if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
        const chromePath = getChromePath();
        if (chromePath) {
            process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
        }
    }

    // PUPPETEER_CACHE_DIR'i de DATA_DIR'e yönlendir (puppeteer kendi cache'ini burada oluşturur)
    process.env.PUPPETEER_CACHE_DIR = path.join(DATA_DIR, '.puppeteer-cache');

    // Server'ı başlat
    try {
        require('./server');
    } catch (err) {
        dialog.showErrorBox('Sunucu Hatası', 'Server başlatılamadı:\\n' + err.message);
        app.quit();
        return;
    }

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1000,
        minHeight: 650,
        title: 'WhatsApp Mesaj Göndericisi',
        autoHideMenuBar: true,
        backgroundColor: '#080810',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    setTimeout(() => {
        mainWindow.loadURL('http://localhost:3000');
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
            splashWindow = null;
        }
    }, 2000);

    mainWindow.on('close', (e) => {
        if (isUpdating) return; // Güncelleme kuruluyorsa doğrudan kapat

        e.preventDefault();
        const choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'question',
            buttons: ['Kapat', 'İptal'],
            defaultId: 1,
            title: 'Çıkış',
            message: 'Programı kapatmak istediğinize emin misiniz?\\nTüm WhatsApp bağlantıları kesilecek.'
        });
        if (choice === 0) {
            mainWindow.removeAllListeners('close');
            mainWindow.close();
            app.quit();
        }
    });
}

// ─── IPC Handlers ───────────────────────────────────────────────────────────

ipcMain.on('splash-cancel', () => {
    app.quit();
});

ipcMain.on('splash-install', () => {
    installDependencies();
});

// ─── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
    createSplashWindow();
    runChecks();
});

app.on('window-all-closed', () => {
    app.quit();
});
