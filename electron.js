const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const dialog = electron.dialog;
const ipcMain = electron.ipcMain;
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, execSync, spawnSync } = require('child_process');
const https = require('https');

let mainWindow;
let splashWindow;
let licenseWindow;
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
const LICENSE_FILE = path.join(DATA_DIR, 'license.json');
const LICENSE_VERIFY_URL = 'https://kaenlabs.net/api/verify.php';
const LICENSE_SECRET = 'K4eN_L4b5_2026_pr0d_s3cur1ty';
const LICENSE_PRODUCT = 'whatsapp-sender';
const LICENSE_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

// Windows UTF-8 uyumu: cmd.exe'yi UTF-8 kod sayfasına geçir
function utf8Cmd(cmd) {
    return process.platform === 'win32' ? 'chcp 65001 >nul & ' + cmd : cmd;
}

// Windows 8.3 kısa yol adı (non-ASCII yollar için)
function getShortPath(p) {
    if (process.platform !== 'win32' || !/[^\x00-\x7F]/.test(p)) return p;
    try {
        const r = spawnSync('cmd', ['/c', 'for %A in ("' + p + '") do @echo %~sA'], {
            encoding: 'utf8', timeout: 5000, windowsHide: true
        });
        const short = (r.stdout || '').trim().split('\n').pop().trim();
        if (short && /^[A-Za-z]:\\/.test(short) && fs.existsSync(short)) return short;
    } catch(e) {}
    return p;
}

function getMachineFingerprint() {
    return [
        process.platform,
        process.arch,
        process.env.COMPUTERNAME || '',
        process.env.USERDOMAIN || '',
        app.getPath('userData') || '',
        DATA_DIR
    ].join('|');
}

function createInstallationId() {
    return crypto.createHash('sha256')
        .update(getMachineFingerprint() + '|' + crypto.randomUUID())
        .digest('hex')
        .slice(0, 32);
}

function getLicenseDomain(installationId) {
    return 'desktop:' + installationId;
}

function readLicenseFile() {
    try {
        if (!fs.existsSync(LICENSE_FILE)) return null;
        const parsed = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
        console.log('[License] license.json okunamadı:', e.message);
        return null;
    }
}

function writeLicenseFile(data) {
    const nextData = {
        installationId: data.installationId || createInstallationId(),
        licenseKey: String(data.licenseKey || '').trim(),
        activatedAt: data.activatedAt || new Date().toISOString(),
        lastVerifiedAt: data.lastVerifiedAt || null,
        lastSuccessAt: data.lastSuccessAt || null,
        lastError: data.lastError || '',
        status: data.status || 'pending'
    };
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(nextData, null, 2), 'utf8');
    return nextData;
}

function getOrCreateLicenseState() {
    const existing = readLicenseFile();
    if (existing && existing.installationId) {
        return existing;
    }
    return writeLicenseFile({
        installationId: existing && existing.installationId ? existing.installationId : createInstallationId(),
        licenseKey: existing && existing.licenseKey ? existing.licenseKey : '',
        activatedAt: existing && existing.activatedAt ? existing.activatedAt : null,
        lastVerifiedAt: existing && existing.lastVerifiedAt ? existing.lastVerifiedAt : null,
        lastSuccessAt: existing && existing.lastSuccessAt ? existing.lastSuccessAt : null,
        lastError: existing && existing.lastError ? existing.lastError : '',
        status: existing && existing.status ? existing.status : 'missing'
    });
}

function buildLicenseSignature(payload) {
    return crypto
        .createHmac('sha256', LICENSE_SECRET)
        .update(JSON.stringify(payload))
        .digest('hex');
}

function verifyLicenseResponse(responseBody) {
    if (!responseBody || typeof responseBody !== 'object') {
        throw new Error('Geçersiz lisans yanıtı');
    }
    const received = String(responseBody.signature || '').trim();
    if (!received) {
        throw new Error('Lisans yanıt imzası eksik');
    }
    const payload = { ...responseBody };
    delete payload.signature;
    const expected = buildLicenseSignature(payload);
    if (received !== expected) {
        throw new Error('Lisans yanıt imzası doğrulanamadı');
    }
    return payload;
}

function requestJson(url, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const request = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            },
            timeout: 15000
        }, (response) => {
            let responseText = '';
            response.on('data', (chunk) => {
                responseText += chunk;
            });
            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    return reject(new Error('HTTP ' + response.statusCode));
                }
                try {
                    resolve(JSON.parse(responseText));
                } catch (e) {
                    reject(new Error('Lisans sunucusu geçersiz JSON döndürdü'));
                }
            });
        });
        request.on('error', reject);
        request.on('timeout', () => request.destroy(new Error('Lisans sunucusu zaman aşımına uğradı')));
        request.write(body);
        request.end();
    });
}

async function verifyLicenseWithServer(licenseKey, installationId, action) {
    const payload = {
        license_key: String(licenseKey || '').trim(),
        domain: getLicenseDomain(installationId),
        product: LICENSE_PRODUCT,
        action: action || 'verify',
        server_ip: '',
        timestamp: Math.floor(Date.now() / 1000)
    };
    const response = await requestJson(LICENSE_VERIFY_URL, {
        ...payload,
        signature: buildLicenseSignature(payload)
    });
    const verified = verifyLicenseResponse(response);
    const success = !!(verified.valid || verified.success || verified.status === 'valid' || verified.status === 'active');
    return {
        ok: success,
        message: verified.message || (success ? 'Lisans doğrulandı' : 'Lisans doğrulanamadı'),
        data: verified
    };
}

function canUseGracePeriod(licenseState) {
    if (!licenseState || !licenseState.lastSuccessAt) return false;
    const lastSuccess = new Date(licenseState.lastSuccessAt).getTime();
    if (!lastSuccess || Number.isNaN(lastSuccess)) return false;
    return Date.now() - lastSuccess <= LICENSE_GRACE_PERIOD_MS;
}

function createLicenseWindow() {
    licenseWindow = new BrowserWindow({
        width: 520,
        height: 560,
        resizable: false,
        maximizable: false,
        minimizable: false,
        autoHideMenuBar: true,
        show: false,
        backgroundColor: '#080810',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    const licenseHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Segoe UI',sans-serif;background:linear-gradient(180deg,#06070f,#0b1020);color:#eef2ff;padding:24px;display:flex;min-height:100vh;align-items:center;justify-content:center;}
.card{width:100%;background:linear-gradient(180deg,rgba(13,16,31,0.98),rgba(10,13,27,0.98));border:1px solid rgba(139,92,246,0.25);border-radius:20px;padding:26px;box-shadow:0 24px 90px rgba(0,0,0,0.45);}
.badge{display:inline-block;padding:7px 12px;border-radius:999px;background:rgba(139,92,246,0.16);border:1px solid rgba(167,139,250,0.22);color:#ede9fe;font-size:12px;font-weight:800;margin-bottom:14px;}
h1{font-size:24px;color:#f8fbff;margin-bottom:8px;}
.sub{font-size:13px;color:#aeb8d3;line-height:1.6;margin-bottom:20px;}
label{display:block;font-size:12px;font-weight:700;margin-bottom:8px;color:#dbe4ff;}
input{width:100%;padding:14px 15px;border-radius:12px;border:1px solid rgba(139,92,246,0.22);background:#0f1428;color:#fff;font-size:14px;outline:none;}
input:focus{border-color:#8b5cf6;box-shadow:0 0 0 3px rgba(139,92,246,0.14);}
.hint{margin-top:10px;font-size:11px;color:#7f8aa6;line-height:1.5;}
.meta{margin-top:14px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);font-size:12px;color:#cbd5e1;line-height:1.6;}
.status{margin-top:14px;min-height:44px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);font-size:13px;line-height:1.5;color:#dbe4ff;white-space:pre-line;}
.status.ok{border-color:rgba(34,197,94,0.30);color:#bbf7d0;background:rgba(34,197,94,0.10);}
.status.err{border-color:rgba(239,68,68,0.30);color:#fecaca;background:rgba(239,68,68,0.10);}
.actions{display:flex;gap:10px;margin-top:18px;}
button{flex:1;padding:12px 14px;border:none;border-radius:12px;font-size:13px;font-weight:800;cursor:pointer;transition:opacity .2s ease;}
button:hover{opacity:.9;}
button:disabled{opacity:.5;cursor:not-allowed;}
.primary{background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;}
.ghost{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);color:#cbd5e1;}
</style></head>
<body>
<div class="card">
    <span class="badge">WhatsApp Sender Lisans</span>
    <h1>Lisans anahtarınızı girin</h1>
    <div class="sub">Uygulama açılmadan önce lisans sunucusuyla doğrulama yapılır. Güncellemelerde lisans bilgisi bu cihaza kalıcı olarak bağlı kalır.</div>
    <label for="license-key">Lisans anahtarı</label>
    <input id="license-key" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false">
    <div class="hint">Bu kurulum kimliği yalnızca bu uygulama kurulumu için kullanılır ve güncellemede korunur.</div>
    <div class="meta" id="install-meta">Kurulum hazırlanıyor...</div>
    <div class="status" id="license-status">Lütfen lisans anahtarınızı girin.</div>
    <div class="actions">
        <button class="ghost" onclick="require('electron').ipcRenderer.send('license-cancel')">Kapat</button>
        <button class="primary" id="activate-btn" onclick="activateLicense()">Etkinleştir</button>
    </div>
</div>
<script>
const { ipcRenderer } = require('electron');
const statusEl = document.getElementById('license-status');
const keyEl = document.getElementById('license-key');
const btnEl = document.getElementById('activate-btn');
const metaEl = document.getElementById('install-meta');

window.addEventListener('error', function(event) {
    setStatus('Arayüz hatası: ' + (event && event.message ? event.message : 'Bilinmeyen hata'), 'err');
});

window.addEventListener('unhandledrejection', function(event) {
    const reason = event && event.reason;
    const message = reason && reason.message ? reason.message : String(reason || 'Bilinmeyen promise hatası');
    setStatus('Aktivasyon hatası: ' + message, 'err');
});

ipcRenderer.on('license-debug', (_event, payload) => {
    if (!payload || !payload.message) return;
    setStatus(payload.message, payload.type || '');
});

console.log('[LicenseRenderer] hazır');

function setStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = 'status' + (type ? ' ' + type : '');
}

function activateLicense() {
    const licenseKey = keyEl.value.trim();
    if (!licenseKey) {
        setStatus('Lisans anahtarı boş olamaz.', 'err');
        keyEl.focus();
        return;
    }
    btnEl.disabled = true;
    setStatus('Lisans doğrulanıyor, lütfen bekleyin...');
    ipcRenderer.invoke('license-activate', { licenseKey }).then((result) => {
        btnEl.disabled = false;
        if (result && result.ok) {
            setStatus(result.message || 'Lisans doğrulandı. Uygulama açılıyor...', 'ok');
            setTimeout(() => {
                ipcRenderer.send('license-activation-complete');
            }, 250);
            return;
        }
        setStatus(result && result.message ? result.message : 'Lisans doğrulanamadı.', 'err');
    }).catch((err) => {
        btnEl.disabled = false;
        setStatus(err && err.message ? err.message : 'Bilinmeyen lisans hatası.', 'err');
    });
}

ipcRenderer.on('license-state', (_event, payload) => {
    const state = payload || {};
    metaEl.textContent = 'Kurulum Kimliği: ' + (state.installationId || '-') + '\nBağlama: ' + (state.domain || '-');
    if (state.licenseKey) keyEl.value = state.licenseKey;
    if (state.message) setStatus(state.message, state.ok ? 'ok' : (state.type || ''));
});

keyEl.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') activateLicense();
});
</script>
</body></html>`;

    licenseWindow.on('closed', () => {
        licenseWindow = null;
    });
    licenseWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(licenseHtml));
    return licenseWindow;
}

function showSplashWindow() {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.show();
        splashWindow.focus();
        splashWindow.setAlwaysOnTop(true, 'screen-saver');
        splashWindow.moveTop();
        setTimeout(() => {
            if (splashWindow && !splashWindow.isDestroyed()) {
                splashWindow.setAlwaysOnTop(false);
            }
        }, 1200);
    }
}

function hideLicenseWindow() {
    if (licenseWindow && !licenseWindow.isDestroyed()) {
        licenseWindow.close();
    }
    licenseWindow = null;
}

function showLicenseWindow(state, message, type) {
    console.log('[License] showLicenseWindow çağrıldı');
    if (!licenseWindow || licenseWindow.isDestroyed()) {
        createLicenseWindow();
    }
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.hide();
    }
    const currentState = state || getOrCreateLicenseState();
    const payload = {
        installationId: currentState.installationId,
        domain: getLicenseDomain(currentState.installationId),
        licenseKey: currentState.licenseKey || '',
        ok: type === 'ok',
        type: type || '',
        message: message || (currentState.licenseKey ? 'Lisans doğrulaması gerekiyor.' : 'Lütfen lisans anahtarınızı girin.')
    };
    const sendState = () => {
        licenseWindow?.webContents?.send('license-state', payload);
    };
    if (licenseWindow.webContents.isLoading()) {
        licenseWindow.webContents.once('did-finish-load', sendState);
    } else {
        sendState();
    }
    licenseWindow.show();
    licenseWindow.focus();
}

async function ensureLicenseIsValid() {
    const state = getOrCreateLicenseState();
    if (!state.licenseKey) {
        showLicenseWindow(state, 'Lisans bulunamadı. Devam etmek için lisans anahtarınızı girin.');
        return false;
    }
    try {
        const result = await verifyLicenseWithServer(state.licenseKey, state.installationId, 'verify');
        if (!result.ok) {
            writeLicenseFile({
                ...state,
                lastVerifiedAt: new Date().toISOString(),
                lastError: result.message,
                status: 'invalid'
            });
            showLicenseWindow({ ...state, status: 'invalid' }, result.message || 'Lisans doğrulanamadı.', 'err');
            return false;
        }
        writeLicenseFile({
            ...state,
            licenseKey: state.licenseKey,
            lastVerifiedAt: new Date().toISOString(),
            lastSuccessAt: new Date().toISOString(),
            lastError: '',
            status: 'active'
        });
        hideLicenseWindow();
        return true;
    } catch (err) {
        if (canUseGracePeriod(state)) {
            console.log('[License] Sunucuya ulaşılamadı, grace period ile devam ediliyor:', err.message);
            return true;
        }
        writeLicenseFile({
            ...state,
            lastVerifiedAt: new Date().toISOString(),
            lastError: err.message || String(err),
            status: 'offline'
        });
        showLicenseWindow(state, 'Lisans sunucusuna ulaşılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.\n\nDetay: ' + (err.message || String(err)), 'err');
        return false;
    }
}

async function openLicensedApp() {
    const allowed = await ensureLicenseIsValid();
    if (!allowed) return;
    showSplashWindow();
    runChecks();
}


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
        show: false,
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
    return splashWindow;
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
        exec(utf8Cmd(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${CHROMIUM_DIR}' -Force"`), {
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
    if (splashWindow && !splashWindow.isDestroyed() && !splashWindow.isVisible()) {
        splashWindow.show();
    }
    splashWindow.webContents.send('installing');

    try {
        // 1) node_modules eksikse npm install
        if (!checkNodeModules()) {
            splashWindow.webContents.send('check-result', {
                id: 'node_modules', ok: false, installing: true, statusText: 'Yükleniyor...'
            });
            splashWindow.webContents.send('install-log', 'npm install çalıştırılıyor...');

            await new Promise((resolve, reject) => {
                const proc = exec(utf8Cmd('npm install --production'), {
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
                        exec(utf8Cmd(`npx puppeteer browsers install chrome --path "${getShortPath(CHROMIUM_DIR)}"`), {
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
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        return;
    }

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
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.once('ready-to-show', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.show();
        mainWindow.focus();
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
            splashWindow = null;
        }
    });

    setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.loadURL('http://localhost:3000');
    }, 200);

    setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
            mainWindow.show();
            mainWindow.focus();
        }
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
            splashWindow = null;
        }
    }, 4000);

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.webContents.send('install-error', 'Arayüz yüklenemedi: ' + errorDescription + ' (' + errorCode + ')');
            splashWindow.show();
            splashWindow.focus();
        }
    });

    mainWindow.webContents.on('did-finish-load', () => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
            mainWindow.show();
            mainWindow.focus();
        }
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.webContents.send('install-error', 'Arayüz çöktü: ' + (details && details.reason ? details.reason : 'bilinmeyen hata'));
            splashWindow.show();
            splashWindow.focus();
        }
    });

    mainWindow.webContents.on('unresponsive', () => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.webContents.send('install-error', 'Arayüz yanıt vermiyor.');
            splashWindow.show();
            splashWindow.focus();
        }
    });

    mainWindow.loadURL('http://localhost:3000');

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

ipcMain.on('license-cancel', () => {
    app.quit();
});

ipcMain.on('license-activation-complete', () => {
    hideLicenseWindow();
    if (app.isReady()) {
        app.focus({ steal: true });
    }
    showSplashWindow();
    runChecks();
});

ipcMain.handle('license-activate', async (_event, payload) => {
    const licenseKey = String(payload && payload.licenseKey ? payload.licenseKey : '').trim();
    console.log('[License] activation istendi');
    if (!licenseKey) {
        return { ok: false, message: 'Lisans anahtarı boş olamaz.' };
    }

    const currentState = getOrCreateLicenseState();
    try {
        const result = await verifyLicenseWithServer(licenseKey, currentState.installationId, 'activate');
        console.log('[License] activation sonucu:', result);
        if (!result.ok) {
            writeLicenseFile({
                ...currentState,
                licenseKey,
                lastVerifiedAt: new Date().toISOString(),
                lastError: result.message,
                status: 'invalid'
            });
            licenseWindow?.webContents?.send('license-debug', { message: result.message || 'Lisans etkinleştirilemedi.', type: 'err' });
            return { ok: false, message: result.message || 'Lisans etkinleştirilemedi.' };
        }

        writeLicenseFile({
            ...currentState,
            licenseKey,
            activatedAt: currentState.activatedAt || new Date().toISOString(),
            lastVerifiedAt: new Date().toISOString(),
            lastSuccessAt: new Date().toISOString(),
            lastError: '',
            status: 'active'
        });

        licenseWindow?.webContents?.send('license-debug', { message: result.message || 'Lisans doğrulandı. Uygulama açılıyor...', type: 'ok' });
        return { ok: true, message: result.message || 'Lisans doğrulandı. Uygulama açılıyor...' };
    } catch (err) {
        console.log('[License] activation exception:', err.message || String(err));
        writeLicenseFile({
            ...currentState,
            licenseKey,
            lastVerifiedAt: new Date().toISOString(),
            lastError: err.message || String(err),
            status: 'offline'
        });
        licenseWindow?.webContents?.send('license-debug', { message: err.message || 'Lisans sunucusuna ulaşılamadı.', type: 'err' });
        return { ok: false, message: err.message || 'Lisans sunucusuna ulaşılamadı.' };
    }
});

// ─── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
    createSplashWindow();
    openLicensedApp();
});

app.on('window-all-closed', () => {
    app.quit();
});
