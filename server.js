const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { exec, spawn, execSync } = require('child_process');
const net = require('net');
const zlib = require('zlib');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// accountId -> { client, status, name }
const accounts = {};

let sendingInProgress = false;
let stopRequested = false;

// ─── Veri dizini (ASAR dışında yazılabilir alan) ────────────────────────────
// Electron portable EXE'de __dirname ASAR içine işaret eder (read-only).
// Bu yüzden verileri EXE'nin yanına veya çalışma dizinine yazıyoruz.
function getDataDir() {
    // Electron portable EXE'de PORTABLE_EXECUTABLE_DIR gerçek EXE konumunu verir
    // (process.execPath geçici temp dizinine işaret eder, kullanılmaz)
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
        const dataDir = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'whatsapp-sender-data');
        if (!fs.existsSync(dataDir)) {
            try { fs.mkdirSync(dataDir, { recursive: true }); } catch(e) {}
        }
        return dataDir;
    }
    // ASAR içinde ama portable değilse (installed Electron)
    if (process.resourcesPath && __dirname.includes('.asar')) {
        const dataDir = path.join(path.dirname(process.execPath), 'whatsapp-sender-data');
        if (!fs.existsSync(dataDir)) {
            try { fs.mkdirSync(dataDir, { recursive: true }); } catch(e) {}
        }
        return dataDir;
    }
    // Normal node çalışmasında __dirname kullan
    return __dirname;
}

const DATA_DIR = getDataDir();
console.log('📁 Veri dizini:', DATA_DIR);

// ─── Message storage ────────────────────────────────────────────────────────
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const SENT_LOG_FILE = path.join(DATA_DIR, 'sent-log.json');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const PROXY_FILE = path.join(DATA_DIR, 'proxy.json');
const REPLIES_FILE = path.join(DATA_DIR, 'replies.json');
let savedMessages = [];
let sentLog = [];
let savedNotes = [];
let replies = [];
let sentNumbers = new Set();
let proxyConfig = { enabled: false, type: 'http', host: '', port: '', username: '', password: '' };

function loadMessagesFromFile() {
    try {
        if (fs.existsSync(MESSAGES_FILE)) {
            savedMessages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
        }
    } catch (e) {
        savedMessages = [];
    }
}

function saveMessagesToFile() {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(savedMessages, null, 2));
}

function loadSentLog() {
    try {
        if (fs.existsSync(SENT_LOG_FILE)) {
            sentLog = JSON.parse(fs.readFileSync(SENT_LOG_FILE, 'utf8'));
        }
    } catch (e) { sentLog = []; }
}

function saveSentLog() {
    fs.writeFileSync(SENT_LOG_FILE, JSON.stringify(sentLog, null, 2));
}

function loadNotes() {
    try {
        if (fs.existsSync(NOTES_FILE)) {
            savedNotes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
        }
    } catch (e) { savedNotes = []; }
}

function saveNotesToFile() {
    fs.writeFileSync(NOTES_FILE, JSON.stringify(savedNotes, null, 2));
}

function loadProxyConfig() {
    try {
        if (fs.existsSync(PROXY_FILE)) {
            proxyConfig = JSON.parse(fs.readFileSync(PROXY_FILE, 'utf8'));
        }
    } catch (e) { /* default */ }
}

function saveProxyConfig() {
    fs.writeFileSync(PROXY_FILE, JSON.stringify(proxyConfig, null, 2));
}

function loadReplies() {
    try {
        if (fs.existsSync(REPLIES_FILE)) {
            replies = JSON.parse(fs.readFileSync(REPLIES_FILE, 'utf8'));
        }
    } catch (e) { replies = []; }
}

function saveReplies() {
    fs.writeFileSync(REPLIES_FILE, JSON.stringify(replies, null, 2));
}

function rebuildSentNumbers() {
    sentNumbers = new Set(sentLog.filter(s => s.status === 'ba\u015Far\u0131l\u0131').map(s => s.number.replace(/\D/g, '')));
}

loadMessagesFromFile();
loadSentLog();
loadNotes();
loadProxyConfig();
loadReplies();
rebuildSentNumbers();

// ─── Tor VPN ────────────────────────────────────────────────────────────────
const TOR_DIR = path.join(DATA_DIR, 'tor');
let torProcess = null;
let torReady = false;

function findTorExe() {
    const bundled = path.join(TOR_DIR, 'tor', 'tor.exe');
    if (fs.existsSync(bundled)) return bundled;
    try { execSync('where tor.exe', { timeout: 5000, stdio: 'pipe' }); return 'tor.exe'; } catch(e) {}
    const locs = [
        path.join(process.env.LOCALAPPDATA || '', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Tor', 'tor.exe'),
    ].filter(p => p && p.length > 5);
    for (const p of locs) { if (fs.existsSync(p)) return p; }
    return null;
}

function startTor() {
    return new Promise((resolve, reject) => {
        if (torProcess && torReady) return resolve(true);
        if (torProcess) stopTor();
        const torExe = findTorExe();
        if (!torExe) return reject(new Error('tor.exe bulunamadı'));
        const dataDir = path.join(TOR_DIR, 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        // Eski lock dosyasını temizle (önceki crash'ten kalmış olabilir)
        const lockFile = path.join(dataDir, 'lock');
        try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch(e) {}
        const torrcPath = path.join(TOR_DIR, 'torrc');
        const cfgLines = [
            'SocksPort 9050',
            'ControlPort 9051',
            'CookieAuthentication 1',
            'DataDirectory ' + dataDir.replace(/\\/g, '/'),
        ];
        const geoip = path.join(TOR_DIR, 'tor', 'geoip');
        const geoip6 = path.join(TOR_DIR, 'tor', 'geoip6');
        if (fs.existsSync(geoip)) cfgLines.push('GeoIPFile ' + geoip.replace(/\\/g, '/'));
        if (fs.existsSync(geoip6)) cfgLines.push('GeoIPv6File ' + geoip6.replace(/\\/g, '/'));
        fs.writeFileSync(torrcPath, cfgLines.join('\n'));
        const torDir = path.dirname(torExe) !== '.' ? path.dirname(torExe) : TOR_DIR;
        let output = '', stderrOut = '', done = false;
        console.log('[Tor] Başlatılıyor:', torExe);
        console.log('[Tor] CWD:', torDir);
        console.log('[Tor] torrc:', torrcPath);
        torProcess = spawn(torExe, ['-f', torrcPath], {
            cwd: torDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
        });
        const timer = setTimeout(() => {
            if (!done) {
                done = true;
                const hint = output || stderrOut || 'Yanıt yok';
                reject(new Error('Tor başlatma zaman aşımı (30s). Son çıktı: ' + hint.slice(-200)));
            }
        }, 30000);
        torProcess.stdout.on('data', (ch) => {
            output += ch.toString();
            console.log('[Tor]', ch.toString().trim());
            if (!done && output.includes('100%')) {
                torReady = true; done = true; clearTimeout(timer); resolve(true);
            }
        });
        torProcess.stderr.on('data', (ch) => {
            stderrOut += ch.toString();
            console.log('[Tor STDERR]', ch.toString().trim());
        });
        torProcess.on('exit', (code) => {
            const wasReady = torReady;
            torReady = false; torProcess = null;
            const allOutput = (output + ' ' + stderrOut).trim();
            console.log('[Tor] Kapandı, kod:', code, '| Çıktı:', allOutput.slice(-300));
            if (!done) {
                done = true; clearTimeout(timer);
                let errMsg = 'Tor kapandı (kod: ' + code + ')';
                if (allOutput.includes('Address already in use')) errMsg += ' — Port 9050/9051 zaten kullanılıyor. Başka bir Tor açık olabilir.';
                else if (allOutput.includes('Permission denied')) errMsg += ' — Dosya izin hatası. Uygulamayı farklı klasöre taşıyın.';
                else if (allOutput.includes('No such file')) errMsg += ' — Tor dosyaları eksik. Yeniden indirin.';
                else if (allOutput.length > 0) errMsg += ' — ' + allOutput.slice(-150);
                reject(new Error(errMsg));
            }
            if (wasReady) io.emit('tor-status', { running: false });
        });
        torProcess.on('error', (err) => {
            torReady = false; torProcess = null;
            console.log('[Tor] Process error:', err.message);
            if (!done) { done = true; clearTimeout(timer); reject(new Error('Tor çalıştırılamadı: ' + err.message)); }
        });
    });
}

function stopTor() {
    if (torProcess) { try { torProcess.kill(); } catch(e) {} torProcess = null; }
    torReady = false;
}

function torNewIdentity() {
    return new Promise((resolve, reject) => {
        const cookiePath = path.join(TOR_DIR, 'data', 'control_auth_cookie');
        if (!fs.existsSync(cookiePath)) return reject(new Error('Cookie dosyası bulunamadı'));
        const cookie = fs.readFileSync(cookiePath).toString('hex');
        const client = new net.Socket();
        let step = 0, buf = '';
        const timer = setTimeout(() => { client.destroy(); reject(new Error('Timeout')); }, 5000);
        client.connect(9051, '127.0.0.1');
        client.on('connect', () => { client.write('AUTHENTICATE ' + cookie + '\r\n'); });
        client.on('data', (chunk) => {
            buf += chunk.toString();
            if (step === 0 && buf.includes('250 OK')) {
                step = 1; buf = '';
                client.write('SIGNAL NEWNYM\r\n');
            } else if (step === 1 && buf.includes('250 OK')) {
                clearTimeout(timer); client.destroy(); resolve(true);
            } else if (buf.match(/^5\d\d/m)) {
                clearTimeout(timer); client.destroy(); reject(new Error(buf.trim()));
            }
        });
        client.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
}

async function downloadTor() {
    if (findTorExe()) return { success: true, message: 'Tor zaten yüklü' };
    if (!fs.existsSync(TOR_DIR)) fs.mkdirSync(TOR_DIR, { recursive: true });
    const archivePath = path.join(TOR_DIR, 'tor-bundle.tar.gz');

    // Versiyon listesini al
    let versions = [];
    try {
        const html = await httpGet('https://dist.torproject.org/torbrowser/');
        const matches = html.match(/"(\d+\.\d+[\d.]*)\/"/g) || [];
        versions = matches.map(s => s.match(/"([\d.]+)\//)[1]);
        versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch(e) { console.log('[Tor DL] Versiyon listesi alınamadı:', e.message); }
    if (!versions.length) versions = ['14.0.4', '14.0.3', '14.0', '13.5.8'];

    for (const ver of versions.slice(0, 10)) {
        const url = `https://dist.torproject.org/torbrowser/${ver}/tor-expert-bundle-windows-x86_64-${ver}.tar.gz`;
        io.emit('tor-download-progress', { message: `v${ver} indiriliyor...` });
        console.log('[Tor DL] Deneniyor:', url);
        try {
            await httpDownload(url, archivePath);
            if (fs.existsSync(archivePath) && fs.statSync(archivePath).size > 5000000) {
                io.emit('tor-download-progress', { message: 'Arşiv açılıyor...' });
                await extractTarGz(archivePath, TOR_DIR);
                try { fs.unlinkSync(archivePath); } catch(e) {}
                if (findTorExe()) return { success: true, message: 'Tor başarıyla indirildi (v' + ver + ')' };
            }
        } catch(e) {
            console.log('[Tor DL] v' + ver + ' başarısız:', e.message);
        }
        try { fs.unlinkSync(archivePath); } catch(e) {}
    }
    return { success: false, error: 'Tor indirilemedi. Manuel: https://www.torproject.org/download/tor/' };
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 15000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpGet(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function httpDownload(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const req = https.get(url, { timeout: 120000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close();
                try { fs.unlinkSync(dest); } catch(e) {}
                return httpDownload(res.headers.location, dest).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) { file.close(); res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            const total = parseInt(res.headers['content-length'] || '0', 10);
            let downloaded = 0;
            res.on('data', (chunk) => {
                downloaded += chunk.length;
                if (total > 0) {
                    const pct = Math.round(downloaded / total * 100);
                    io.emit('tor-download-progress', { message: 'İndiriliyor... %' + pct + ' (' + Math.round(downloaded / 1024 / 1024) + 'MB)' });
                }
            });
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        });
        req.on('error', (e) => { file.close(); reject(e); });
        req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
    });
}

function extractTarGz(archive, destDir) {
    return new Promise((resolve, reject) => {
        // Önce sistem tar komutunu dene (Windows 10+ dahili tar var)
        exec(`tar xzf "${archive}" -C "${destDir}"`, { timeout: 60000 }, (err) => {
            if (!err && findTorExe()) return resolve();
            // tar yoksa node.js ile aç
            console.log('[Tor DL] Sistem tar başarısız, Node.js ile açılıyor...');
            try {
                const input = fs.createReadStream(archive);
                const gunzip = zlib.createGunzip();
                const chunks = [];
                input.pipe(gunzip);
                gunzip.on('data', (c) => chunks.push(c));
                gunzip.on('end', () => {
                    const tarBuf = Buffer.concat(chunks);
                    extractTarBuffer(tarBuf, destDir);
                    resolve();
                });
                gunzip.on('error', reject);
                input.on('error', reject);
            } catch(e) { reject(e); }
        });
    });
}

function extractTarBuffer(buf, destDir) {
    let offset = 0;
    while (offset < buf.length - 512) {
        const header = buf.slice(offset, offset + 512);
        if (header[0] === 0) break;
        const name = header.slice(0, 100).toString('utf8').replace(/\0/g, '').trim();
        const sizeStr = header.slice(124, 136).toString('utf8').replace(/\0/g, '').trim();
        const size = parseInt(sizeStr, 8) || 0;
        const type = String.fromCharCode(header[156]);
        offset += 512;
        if (name && type !== '5' && size > 0) {
            const filePath = path.join(destDir, name.replace(/\//g, path.sep));
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, buf.slice(offset, offset + size));
        } else if (type === '5') {
            const dirPath = path.join(destDir, name.replace(/\//g, path.sep));
            if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
        }
        offset += Math.ceil(size / 512) * 512;
    }
}

function randomDelay(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

// ─── Random Turkish Name Generator ──────────────────────────────────────────

const FIRST_NAMES = [
    'Ahmet','Mehmet','Mustafa','Ali','Hüseyin','Hasan','İbrahim','İsmail',
    'Yusuf','Osman','Murat','Ömer','Ramazan','Halil','Süleyman','Abdullah',
    'Recep','Fatma','Ayşe','Emine','Hatice','Zeynep','Elif','Meryem',
    'Şerife','Sultan','Hanife','Havva','Merve','Esra','Kübra','Büşra',
    'Özlem','Derya','Tuğba','Seda','Gül','Aslı','Ceren','Deniz',
    'Emre','Burak','Can','Serkan','Onur','Cem','Kerem','Tolga',
    'Barış','Uğur','Volkan','Gökhan','Erkan','Hakan','Sinan','Tuncay',
    'Berk','Arda','Furkan','Eren','Yiğit','Kaan','Enes','Berkay'
];

const LAST_NAMES = [
    'Yılmaz','Kaya','Demir','Çelik','Şahin','Yıldız','Yıldırım','Öztürk',
    'Aydın','Özdemir','Arslan','Doğan','Kılıç','Aslan','Çetin','Kara',
    'Koç','Kurt','Özkan','Şimşek','Polat','Korkmaz','Karaca','Güneş',
    'Aktaş','Erdoğan','Yalçın','Erat','Tekin','Acar','Duran','Aksoy',
    'Balcı','Kaplan','Güler','Taş','Karadağ','Koçak','Avcı','Bulut'
];

function randomName() {
    const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
    const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
    return { first, last, full: first + ' ' + last };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getAccountInfo(id) {
    const acc = accounts[id];
    if (!acc) return null;
    return { id, status: acc.status, name: acc.name || id };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// List all accounts
app.get('/api/accounts', (req, res) => {
    res.json(Object.keys(accounts).map(id => getAccountInfo(id)));
});

// Add a new WhatsApp account
app.post('/api/accounts', (req, res) => {
    const { id } = req.body;
    if (!id || !id.trim()) {
        return res.status(400).json({ error: 'Hesap adı boş olamaz' });
    }
    // Sadece harf, rakam, _ ve - kabul edilir (Türkçe karakterler ve boşluklar temizlenir)
    const accountId = id.trim().replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!accountId) {
        return res.status(400).json({ error: 'Geçersiz hesap adı — harf ve rakam kullanın' });
    }
    if (accounts[accountId]) {
        return res.status(400).json({ error: 'Bu hesap adı zaten kullanılıyor' });
    }

    const puppeteerArgs = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--disable-gpu'
            ];

    // Proxy ayarı varsa ekle
    if (proxyConfig.enabled && proxyConfig.host && proxyConfig.port) {
        const proxyType = proxyConfig.type || 'http';
        if (proxyType === 'socks5') {
            puppeteerArgs.push(`--proxy-server=socks5://${proxyConfig.host}:${proxyConfig.port}`);
        } else {
            puppeteerArgs.push(`--proxy-server=${proxyConfig.host}:${proxyConfig.port}`);
        }
    }

    const puppeteerOpts = {
        headless: true,
        args: puppeteerArgs
    };

    // Sistem Chrome'u varsa kullan (başka PC desteği)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        puppeteerOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: accountId, dataPath: path.join(DATA_DIR, '.wwebjs_auth') }),
        puppeteer: puppeteerOpts
    });

    // Proxy auth gerekiyorsa
    if (proxyConfig.enabled && proxyConfig.username && proxyConfig.password) {
        client.on('page', async (page) => {
            await page.authenticate({
                username: proxyConfig.username,
                password: proxyConfig.password
            });
        });
    }

    accounts[accountId] = { client, status: 'başlatılıyor', name: accountId };

    client.on('qr', async (qr) => {
        try {
            const qrDataUrl = await qrcode.toDataURL(qr, { width: 256, margin: 2 });
            io.emit('qr-code', { id: accountId, qr: qrDataUrl });
            if (accounts[accountId]) {
                accounts[accountId].status = 'qr-bekleniyor';
                io.emit('account-update', getAccountInfo(accountId));
            }
        } catch (err) {
            console.error('QR oluşturma hatası:', err.message);
        }
    });

    client.on('authenticated', () => {
        if (accounts[accountId]) {
            accounts[accountId].status = 'doğrulandı';
            io.emit('account-update', getAccountInfo(accountId));
        }
    });

    client.on('ready', () => {
        if (accounts[accountId] && accounts[accountId].status !== 'bağlı') {
            accounts[accountId].status = 'bağlı';
            accounts[accountId].name = client.info?.pushname || accountId;
            io.emit('account-update', getAccountInfo(accountId));
            io.emit('qr-done', { id: accountId });
            console.log(`✅ Hesap bağlandı: ${accountId}`);
        }

        // Gelen mesaj dinleyici (dönüş takibi)
        client.on('message', async (msg) => {
            try {
                if (msg.fromMe) return;
                const from = msg.from.replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
                if (!from || !sentNumbers.has(from)) return;
                const contact = await msg.getContact();
                const name = contact?.pushname || contact?.name || from;
                const reply = {
                    id: Date.now(),
                    number: from,
                    name: name,
                    message: msg.body || '(medya)',
                    account: accounts[accountId]?.name || accountId,
                    date: new Date().toISOString()
                };
                replies.push(reply);
                saveReplies();
                io.emit('reply-received', reply);
                console.log(`📩 Dönüş: ${from} (${name})`);
            } catch(e) { /* sessizce geç */ }
        });
    });

    client.on('auth_failure', () => {
        if (accounts[accountId]) {
            accounts[accountId].status = 'auth-hatası';
            io.emit('account-update', getAccountInfo(accountId));
        }
    });

    client.on('disconnected', (reason) => {
        if (accounts[accountId]) {
            const isSpam = reason === 'LOGOUT';
            accounts[accountId].status = isSpam ? 'spam-engeli' : 'bağlantı-kesildi';
            io.emit('account-update', getAccountInfo(accountId));
            if (isSpam) {
                console.log(`🚫 WhatsApp SPAM engeli aldı: ${accountId}`);
                io.emit('spam-detected', { id: accountId, reason });
            } else {
                console.log(`⚠️ Bağlantı kesildi: ${accountId} — ${reason}`);
            }
            // Session temizliğini güvenli yap — EBUSY hatasını yakala
            client.destroy().catch(() => {});
            delete accounts[accountId];
            io.emit('account-removed', { id: accountId });
        }
    });

    client.initialize().catch(err => {
        console.error(`Başlatma hatası (${accountId}):`, err.message);
        if (accounts[accountId]) {
            accounts[accountId].status = 'hata';
            io.emit('account-update', getAccountInfo(accountId));
        }
    });

    res.json({ success: true, id: accountId });
});

// Remove an account
app.delete('/api/accounts/:id', async (req, res) => {
    const { id } = req.params;
    if (accounts[id]) {
        try {
            await accounts[id].client.destroy();
        } catch (_) { /* ignore */ }
        delete accounts[id];
        io.emit('account-removed', { id });
        console.log(`🗑️ Hesap silindi: ${id}`);
    }
    res.json({ success: true });
});

// ─── Message CRUD ───────────────────────────────────────────────────────────

app.get('/api/messages', (req, res) => {
    res.json(savedMessages);
});

app.post('/api/messages', (req, res) => {
    const { title, content } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Başlık boş olamaz' });
    if (!content || !content.trim()) return res.status(400).json({ error: 'İçerik boş olamaz' });
    const msg = { id: Date.now(), title: title.trim(), content: content.trim() };
    savedMessages.push(msg);
    saveMessagesToFile();
    res.json(msg);
});

app.put('/api/messages/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const idx = savedMessages.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Mesaj bulunamadı' });
    const { title, content } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Başlık boş olamaz' });
    if (!content || !content.trim()) return res.status(400).json({ error: 'İçerik boş olamaz' });
    savedMessages[idx] = { id, title: title.trim(), content: content.trim() };
    saveMessagesToFile();
    res.json(savedMessages[idx]);
});

app.delete('/api/messages/:id', (req, res) => {
    const id = parseInt(req.params.id);
    savedMessages = savedMessages.filter(m => m.id !== id);
    saveMessagesToFile();
    res.json({ success: true });
});

// ─── Sent Log (silinemeyen gönderim kaydı) ──────────────────────────────────

app.get('/api/sent-log', (req, res) => {
    res.json(sentLog);
});

// \u2500\u2500\u2500 Replies (d\u00f6n\u00fc\u015fler) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

app.get('/api/replies', (req, res) => {
    res.json(replies);
});

// ─── Notes CRUD ─────────────────────────────────────────────────────────────

app.get('/api/notes', (req, res) => {
    res.json(savedNotes);
});

app.post('/api/notes', (req, res) => {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Not boş olamaz' });
    const note = { id: Date.now(), content: content.trim(), date: new Date().toISOString() };
    savedNotes.push(note);
    saveNotesToFile();
    res.json(note);
});

app.delete('/api/notes/:id', (req, res) => {
    const id = parseInt(req.params.id);
    savedNotes = savedNotes.filter(n => n.id !== id);
    saveNotesToFile();
    res.json({ success: true });
});

// ─── Proxy Config ───────────────────────────────────────────────────────────

app.get('/api/proxy', (req, res) => {
    res.json(proxyConfig);
});

app.post('/api/proxy', (req, res) => {
    const { enabled, type, host, port, username, password } = req.body;
    proxyConfig = {
        enabled: !!enabled,
        type: String(type || 'http').trim(),
        host: String(host || '').trim(),
        port: String(port || '').trim(),
        username: String(username || '').trim(),
        password: String(password || '').trim()
    };
    saveProxyConfig();
    res.json({ success: true, proxy: proxyConfig });
});

// ─── Proxy Test (Node.js native — curl bağımlılığı yok) ────────────────────

function nativeHttpGet(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs || 10000);
        const mod = url.startsWith('https') ? https : http;
        mod.get(url, { timeout: timeoutMs || 10000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                clearTimeout(timer);
                return nativeHttpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) { res.resume(); clearTimeout(timer); return reject(new Error('HTTP ' + res.statusCode)); }
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { clearTimeout(timer); resolve(data); });
        }).on('error', e => { clearTimeout(timer); reject(e); });
    });
}

function proxyTestViaHttp(proxyHost, proxyPort, proxyUser, proxyPass) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout (10s)')), 12000);

        // HTTP CONNECT tunnel üzerinden https://api.ipify.org'a bağlan
        const authHeader = (proxyUser && proxyPass) ? 'Proxy-Authorization: Basic ' + Buffer.from(proxyUser + ':' + proxyPass).toString('base64') + '\r\n' : '';
        const connectReq = `CONNECT api.ipify.org:443 HTTP/1.1\r\nHost: api.ipify.org:443\r\n${authHeader}\r\n`;

        const socket = new net.Socket();
        socket.setTimeout(10000);
        socket.connect(parseInt(proxyPort), proxyHost, () => {
            socket.write(connectReq);
        });

        let headerBuf = '';
        let tunnelEstablished = false;

        socket.on('data', (chunk) => {
            if (!tunnelEstablished) {
                headerBuf += chunk.toString();
                if (headerBuf.includes('\r\n\r\n')) {
                    if (headerBuf.startsWith('HTTP/1.1 200') || headerBuf.startsWith('HTTP/1.0 200')) {
                        tunnelEstablished = true;
                        // TLS handshake
                        const tls = require('tls');
                        const tlsSocket = tls.connect({ socket, servername: 'api.ipify.org' }, () => {
                            tlsSocket.write('GET /?format=json HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n');
                        });
                        let body = '';
                        tlsSocket.on('data', d => body += d.toString());
                        tlsSocket.on('end', () => {
                            clearTimeout(timer);
                            const jsonMatch = body.match(/\{[^}]+\}/);
                            if (jsonMatch) {
                                try { resolve(JSON.parse(jsonMatch[0])); } catch(e) { reject(new Error('Yanıt parse hatası')); }
                            } else { reject(new Error('Proxy yanıt vermedi')); }
                            tlsSocket.destroy();
                        });
                        tlsSocket.on('error', e => { clearTimeout(timer); reject(e); });
                    } else {
                        clearTimeout(timer);
                        reject(new Error('Proxy reddetti: ' + headerBuf.split('\r\n')[0]));
                        socket.destroy();
                    }
                }
            }
        });
        socket.on('error', e => { clearTimeout(timer); reject(e); });
        socket.on('timeout', () => { clearTimeout(timer); socket.destroy(); reject(new Error('Bağlantı zaman aşımı')); });
    });
}

function proxyTestViaSocks5(proxyHost, proxyPort, proxyUser, proxyPass) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout (10s)')), 12000);
        const socket = new net.Socket();
        socket.setTimeout(10000);

        const targetHost = 'api.ipify.org';
        const targetPort = 443;
        let step = 0;

        socket.connect(parseInt(proxyPort), proxyHost, () => {
            if (proxyUser && proxyPass) {
                // SOCKS5 with auth: request username/password auth
                socket.write(Buffer.from([0x05, 0x01, 0x02]));
            } else {
                // SOCKS5 no auth
                socket.write(Buffer.from([0x05, 0x01, 0x00]));
            }
        });

        socket.on('data', (chunk) => {
            if (step === 0) {
                // Auth method response
                if (chunk[0] !== 0x05) { clearTimeout(timer); socket.destroy(); return reject(new Error('SOCKS5 değil')); }
                if (chunk[1] === 0x02 && proxyUser && proxyPass) {
                    // Username/password auth
                    const userBuf = Buffer.from(proxyUser);
                    const passBuf = Buffer.from(proxyPass);
                    const authBuf = Buffer.concat([Buffer.from([0x01, userBuf.length]), userBuf, Buffer.from([passBuf.length]), passBuf]);
                    socket.write(authBuf);
                    step = 1;
                } else if (chunk[1] === 0x00) {
                    // No auth needed, send connect request
                    step = 2;
                    sendConnectRequest();
                } else if (chunk[1] === 0xFF) {
                    clearTimeout(timer); socket.destroy(); return reject(new Error('SOCKS5 kimlik doğrulama reddedildi'));
                }
            } else if (step === 1) {
                // Auth response
                if (chunk[1] !== 0x00) { clearTimeout(timer); socket.destroy(); return reject(new Error('SOCKS5 giriş başarısız')); }
                step = 2;
                sendConnectRequest();
            } else if (step === 2) {
                // Connect response
                if (chunk[1] !== 0x00) {
                    const errors = { 1: 'Genel hata', 2: 'İzin yok', 3: 'Ağ erişilemez', 4: 'Host erişilemez', 5: 'Bağlantı reddedildi' };
                    clearTimeout(timer); socket.destroy();
                    return reject(new Error('SOCKS5: ' + (errors[chunk[1]] || 'Hata kodu ' + chunk[1])));
                }
                step = 3;
                // TLS handshake
                const tls = require('tls');
                const tlsSocket = tls.connect({ socket, servername: targetHost }, () => {
                    tlsSocket.write('GET /?format=json HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n');
                });
                let body = '';
                tlsSocket.on('data', d => body += d.toString());
                tlsSocket.on('end', () => {
                    clearTimeout(timer);
                    const jsonMatch = body.match(/\{[^}]+\}/);
                    if (jsonMatch) {
                        try { resolve(JSON.parse(jsonMatch[0])); } catch(e) { reject(new Error('Yanıt parse hatası')); }
                    } else { reject(new Error('Proxy yanıt vermedi')); }
                    tlsSocket.destroy();
                });
                tlsSocket.on('error', e => { clearTimeout(timer); reject(e); });
            }
        });

        function sendConnectRequest() {
            const hostBuf = Buffer.from(targetHost);
            const portBuf = Buffer.alloc(2);
            portBuf.writeUInt16BE(targetPort);
            socket.write(Buffer.concat([
                Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
                hostBuf,
                portBuf
            ]));
        }

        socket.on('error', e => { clearTimeout(timer); reject(e); });
        socket.on('timeout', () => { clearTimeout(timer); socket.destroy(); reject(new Error('Bağlantı zaman aşımı')); });
    });
}

app.post('/api/proxy/test', async (req, res) => {
    const { type, host, port, username, password } = req.body;
    if (!host || !port) {
        return res.status(400).json({ error: 'Host ve Port gerekli' });
    }

    const proxyType = (type || 'http').toLowerCase();

    try {
        let result;
        if (proxyType === 'socks5') {
            result = await proxyTestViaSocks5(host, port, username, password);
        } else {
            result = await proxyTestViaHttp(host, port, username, password);
        }
        return res.json({ success: true, ip: result.ip });
    } catch(err) {
        return res.json({ success: false, error: 'Proxy bağlantısı başarısız — ' + err.message });
    }
});

// Proxy olmadan gerçek IP'yi göster (Node.js native — curl gerekmiyor)
app.get('/api/myip', async (req, res) => {
    try {
        const data = await nativeHttpGet('https://api.ipify.org?format=json', 10000);
        const parsed = JSON.parse(data);
        res.json({ ip: parsed.ip });
    } catch(e) {
        res.json({ ip: 'bilinmiyor' });
    }
});

// ─── Cloudflare WARP VPN ────────────────────────────────────────────────────

function runCmd(cmd, timeoutMs) {
    return new Promise((resolve) => {
        exec(cmd, { timeout: timeoutMs || 15000 }, (err, stdout, stderr) => {
            resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || '').trim() });
        });
    });
}

app.get('/api/warp/status', async (req, res) => {
    // WARP CLI yüklü mü?
    const check = await runCmd('warp-cli --version');
    if (!check.ok) {
        return res.json({ installed: false, connected: false, message: 'WARP yüklü değil' });
    }
    // Bağlantı durumu
    const status = await runCmd('warp-cli status');
    const connected = status.out.toLowerCase().includes('connected');
    const mode = status.out.toLowerCase().includes('warp+doh') ? 'warp+doh'
               : status.out.toLowerCase().includes('doh') ? 'doh'
               : status.out.toLowerCase().includes('warp') ? 'warp' : 'unknown';
    res.json({ installed: true, connected, mode, details: status.out });
});

app.post('/api/warp/connect', async (req, res) => {
    const check = await runCmd('warp-cli --version');
    if (!check.ok) {
        return res.json({ success: false, error: 'Cloudflare WARP yüklü değil. https://1.1.1.1 adresinden indirin.' });
    }

    // Proxy moduna al (SOCKS5 127.0.0.1:40000)
    await runCmd('warp-cli mode proxy');
    await runCmd('warp-cli connect');

    // Bağlandı mı kontrol et
    await new Promise(r => setTimeout(r, 3000));
    const status = await runCmd('warp-cli status');
    const connected = status.out.toLowerCase().includes('connected');

    if (connected) {
        // Proxy config'i otomatik WARP SOCKS5'e ayarla
        proxyConfig = {
            enabled: true,
            type: 'socks5',
            host: '127.0.0.1',
            port: '40000',
            username: '',
            password: ''
        };
        saveProxyConfig();
        res.json({ success: true, message: 'WARP bağlandı — SOCKS5 proxy 127.0.0.1:40000 aktif' });
    } else {
        res.json({ success: false, error: 'WARP bağlanamadı: ' + status.out });
    }
});

app.post('/api/warp/disconnect', async (req, res) => {
    await runCmd('warp-cli disconnect');
    // Proxy'yi kapat
    proxyConfig.enabled = false;
    saveProxyConfig();
    res.json({ success: true, message: 'WARP bağlantısı kesildi' });
});

// ─── Tor VPN Endpoints ───────────────────────────────────────────────────────

app.get('/api/tor/status', (req, res) => {
    res.json({ installed: !!findTorExe(), running: torReady, port: 9050 });
});

app.post('/api/tor/start', async (req, res) => {
    try {
        const torExe = findTorExe();
        if (!torExe) return res.json({ success: false, needsDownload: true, error: 'Tor bulunamadı. İndirme gerekli.' });
        await startTor();
        proxyConfig = { enabled: true, type: 'socks5', host: '127.0.0.1', port: '9050', username: '', password: '' };
        saveProxyConfig();
        res.json({ success: true, message: 'Tor bağlandı — SOCKS5 127.0.0.1:9050' });
    } catch(err) {
        const needsReinstall = /kapandı|dosya|eksik|permission|çalıştırılamadı/i.test(err.message);
        res.json({ success: false, error: err.message, needsReinstall });
    }
});

app.post('/api/tor/stop', (req, res) => {
    stopTor();
    proxyConfig.enabled = false;
    saveProxyConfig();
    res.json({ success: true, message: 'Tor kapatıldı' });
});

app.post('/api/tor/newip', async (req, res) => {
    if (!torReady) return res.json({ success: false, error: 'Tor çalışmıyor' });
    try {
        await torNewIdentity();
        res.json({ success: true, message: 'Yeni IP devre alındı (birkaç saniye içinde aktif olur)' });
    } catch(err) {
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/tor/download', (req, res) => {
    const force = req.body && req.body.force;
    if (!force && findTorExe()) return res.json({ success: true, message: 'Tor zaten yüklü' });
    // Force modunda eski dosyaları temizle
    if (force) {
        console.log('[Tor DL] Force reinstall — eski dosyalar siliniyor');
        const torSubDir = path.join(TOR_DIR, 'tor');
        try { if (fs.existsSync(torSubDir)) fs.rmSync(torSubDir, { recursive: true, force: true }); } catch(e) {}
        const dataSubDir = path.join(TOR_DIR, 'data');
        try { if (fs.existsSync(dataSubDir)) fs.rmSync(dataSubDir, { recursive: true, force: true }); } catch(e) {}
    }
    res.json({ success: true, downloading: true, message: 'İndirme başlatıldı...' });
    downloadTor().then(result => {
        io.emit('tor-download-complete', result);
    }).catch(err => {
        console.log('[Tor DL] Hata:', err.message);
        io.emit('tor-download-complete', { success: false, error: 'İndirme hatası: ' + err.message });
    });
});

// Start sending messages
app.post('/api/send', (req, res) => {
    if (sendingInProgress) {
        return res.status(400).json({ error: 'Gönderim zaten devam ediyor' });
    }

    const { numbers, message, messages: msgList, messageMode, delayMin, delayMax, burstCount, burstPause } = req.body;

    if (!numbers || numbers.length === 0) {
        return res.status(400).json({ error: 'Numara listesi boş' });
    }
    const messageList = (msgList && msgList.length > 0) ? msgList.map(m => String(m).trim()).filter(Boolean) : (message && message.trim() ? [message.trim()] : []);
    if (messageList.length === 0) {
        return res.status(400).json({ error: 'En az bir mesaj seçmelisiniz' });
    }

    const connectedAccounts = Object.keys(accounts).filter(
        id => accounts[id]?.status === 'bağlı'
    );
    if (connectedAccounts.length === 0) {
        return res.status(400).json({ error: 'Hiç bağlı hesap yok' });
    }

    const validNumbers = numbers
        .map(n => String(n).trim().replace(/\D/g, ''))
        .filter(n => n.length >= 10);

    if (validNumbers.length === 0) {
        return res.status(400).json({ error: 'Geçerli numara bulunamadı' });
    }

    const opts = {
        delayMin:   Math.max(1000,  parseInt(delayMin)  || 15000),
        delayMax:   Math.max(2000,  parseInt(delayMax)  || 45000),
        burstCount: Math.max(1,     parseInt(burstCount) || 10),
        burstPause: Math.max(60000, parseInt(burstPause) || 300000),
    };
    if (opts.delayMax < opts.delayMin) opts.delayMax = opts.delayMin + 5000;

    res.json({ success: true, total: validNumbers.length });

    stopRequested = false;
    sendingInProgress = true;
    sendMessages(validNumbers, messageList, messageMode || 'sequential', connectedAccounts, opts)
        .finally(() => { sendingInProgress = false; });
});

// Stop sending
app.post('/api/stop', (req, res) => {
    if (sendingInProgress) {
        stopRequested = true;
        res.json({ success: true });
    } else {
        res.json({ success: false, error: 'Gönderim zaten durmuş' });
    }
});

// ─── Core send logic ────────────────────────────────────────────────────────

async function sendMessages(numbers, messageList, messageMode, accountIds, opts) {
    io.emit('send-started', { total: numbers.length });

    let successCount = 0;
    let errorCount   = 0;
    let sentThisBurst = 0;

    function pickAccount() {
        // Bağlı hesapları dinamik kontrol et — düşen hesabı atla
        const alive = accountIds.filter(id => accounts[id]?.status === 'bağlı' && accounts[id]?.client);
        if (alive.length === 0) return null;
        return alive[sentThisBurst % alive.length];
    }

    for (let i = 0; i < numbers.length; i++) {
        if (stopRequested) {
            io.emit('send-stopped', { index: i, total: numbers.length, successCount, errorCount });
            return;
        }

        const accountId = pickAccount();
        if (!accountId) {
            io.emit('send-log', { text: '⚠ Tüm hesapların bağlantısı kesildi — gönderim durduruluyor', type: 'err' });
            io.emit('send-stopped', { index: i, total: numbers.length, successCount, errorCount });
            return;
        }
        const client = accounts[accountId]?.client;
        if (!client) { errorCount++; continue; }

        const number = numbers[i];
        const chatId = `${number}@c.us`;

        try {
            // 1) Numaranın gerçek chatId'sini al (varsa)
            let realChatId = chatId;
            try {
                const numberId = await client.getNumberId(number);
                if (numberId) realChatId = numberId._serialized;
            } catch(_) { /* format bulunamazsa default chatId kullan */ }

            // 2) Kişiyi otomatik rastgele isimle kaydet
            const name = randomName();
            try {
                await client.pupPage.evaluate(async (cid, firstName, lastName, fullName) => {
                    try {
                        const contact = await window.Store.Contact.find(cid);
                        if (contact && !contact.isMyContact) {
                            if (!contact.name && !contact.shortName) {
                                contact.name = fullName;
                                contact.shortName = firstName;
                                contact.pushname = fullName;
                            }
                        }
                    } catch(e) {}
                }, realChatId, name.first, name.last, name.full);
                io.emit('send-log', { text: `📇 ${number} → ${name.full} olarak kaydedildi`, type: 'info' });
            } catch(_) { /* contact save sessizce geç */ }

            // 3) Sohbeti aç ve yazıyor simülasyonu
            try {
                const chat = await client.getChatById(realChatId);
                await chat.sendSeen();
                await sleep(randomDelay(800, 1500));
                await chat.sendStateTyping();
                await sleep(randomDelay(2000, 4000));
                await chat.clearState();
            } catch(_) { /* simülasyon hatası önemsiz */ }

            // 4) Mesaj seç ve gönder
            const msgText = messageMode === 'random'
                ? messageList[Math.floor(Math.random() * messageList.length)]
                : messageList[i % messageList.length];
            await client.sendMessage(realChatId, msgText);
            successCount++;
            sentThisBurst++;

            // Gönderim kaydını logla
            sentLog.push({
                number, account: accounts[accountId]?.name || accountId,
                status: 'başarılı', date: new Date().toISOString()
            });
            sentNumbers.add(number.replace(/\D/g, ''));
            saveSentLog();
            io.emit('sent-log-update', sentLog);

            io.emit('send-progress', {
                number, accountId,
                accountName: accounts[accountId]?.name || accountId,
                status: 'başarılı',
                index: i + 1, total: numbers.length,
                successCount, errorCount
            });
        } catch (err) {
            errorCount++;

            // Hatalı gönderimleri de logla
            sentLog.push({
                number, account: accounts[accountId]?.name || accountId,
                status: 'hata', error: err.message, date: new Date().toISOString()
            });
            saveSentLog();
            io.emit('sent-log-update', sentLog);

            io.emit('send-progress', {
                number, accountId,
                accountName: accounts[accountId]?.name || accountId,
                status: 'hata', error: err.message,
                index: i + 1, total: numbers.length,
                successCount, errorCount
            });
        }

        if (i < numbers.length - 1 && !stopRequested) {
            // Burst mola: N mesajda bir uzun bekleme
            if (sentThisBurst > 0 && sentThisBurst % opts.burstCount === 0) {
                const pauseSec = Math.round(opts.burstPause / 1000);
                console.log(`⏸ ${opts.burstCount} mesaj gönderildi, ${pauseSec}sn mola...`);
                io.emit('send-pause', { seconds: pauseSec, index: i + 1, total: numbers.length });
                await sleep(opts.burstPause);
                if (stopRequested) break;
            } else {
                const wait = randomDelay(opts.delayMin, opts.delayMax);
                await sleep(wait);
            }
        }
    }

    io.emit('send-complete', { total: numbers.length, successCount, errorCount });
    console.log(`📨 Gönderim tamamlandı — Başarılı: ${successCount}, Hatalı: ${errorCount}`);
}

// ─── Unhandled errors — sunucunun crash olmasını önle ───────────────────────

process.on('uncaughtException', (err) => {
    console.error('⚠️ Yakalanmamış hata (sunucu çalışmaya devam ediyor):', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('⚠️ Yakalanmamış promise hatası:', err?.message || err);
});

// ─── Start server ────────────────────────────────────────────────────────────

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`\n✅ Sunucu başlatıldı → http://localhost:${PORT}`);
    console.log('Tarayıcınızda bu adresi açın.\n');
});
