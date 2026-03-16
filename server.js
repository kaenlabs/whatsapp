const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { exec, spawn, execSync, spawnSync } = require('child_process');
const net = require('net');
const zlib = require('zlib');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// accountId -> { client, status, name }
const accounts = {};

let sendingInProgress = false;
let stopRequested = false;
const SEND_PAUSE_POLL_MS = 1500;
const SPEEDY_MODE_DEFAULTS = {
    delayMin: 1000,
    delayMax: 2000,
    antiSpam: { warmup: false, typing: false, offline: false, torIp: false }
};
const SKIPPED_STATUS = 'atlandı';

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

// ─── Uzak Log Sistemi (kaenlabs.net/log.php) ────────────────────────────────
// Hata teşhisi için detaylı logları sunucuya gönderir.
const REMOTE_LOG_URL = 'https://kaenlabs.net/log.php';
const APP_VERSION = (() => {
    try {
        return require('./package.json').version || '2.3.6';
    } catch (_) {
        return '2.3.6';
    }
})();

function remoteLog(level, category, message, extra) {
    try {
        const payload = JSON.stringify({
            v: APP_VERSION,
            ts: new Date().toISOString(),
            level: level,       // info, warn, error
            cat: category,      // tor, app, send, proxy
            msg: message,
            extra: extra || {},
            sys: {
                platform: process.platform,
                arch: process.arch,
                nodeVersion: process.version,
                osRelease: os.release(),
                username: os.userInfo().username,
                homedir: os.homedir(),
                dataDir: DATA_DIR,
                hasNonAsciiPath: /[^\x00-\x7F]/.test(DATA_DIR)
            }
        });
        const url = new URL(REMOTE_LOG_URL);
        const options = {
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            timeout: 5000
        };
        const req = https.request(options);
        req.on('error', () => {}); // Sessizce geç — log gönderilemezse uygulama etkilenmemeli
        req.write(payload);
        req.end();
    } catch(e) { /* ignore */ }
}

// ─── Windows UTF-8 / non-ASCII path compat ──────────────────────────────────
// Windows cmd.exe varsayılan OEM kod sayfasını kullanır (Türkçe=857).
// Kullanıcı adında Türkçe karakter varsa (Yiğit, Özge, İbrahim…)
// exec() komutları bozulabilir. chcp 65001 cmd.exe'yi UTF-8'e geçirir.
function utf8Cmd(cmd) {
    return process.platform === 'win32' ? 'chcp 65001 >nul & ' + cmd : cmd;
}

// Windows 8.3 kısa yol adı al (saf ASCII). Tor gibi harici programların
// config dosyalarında non-ASCII yollarla sorun yaşamaması için kullanılır.
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

// Yolun non-ASCII içerip içermediğini ve getShortPath'in çalışıp çalışmadığını kontrol et
function needsSafePath(p) {
    if (!/[^\x00-\x7F]/.test(p)) return false; // ASCII-safe, sorun yok
    const short = getShortPath(p);
    return short === p; // getShortPath başarısız olduysa true
}

// Tor DataDirectory için güvenli (ASCII-only) yol döndür
// Windows kullanıcı adında Türkçe karakter varsa ve 8.3 kısa ad üretilemezse
// C:\ProgramData\whatsapp-sender\tor-data kullanılır
function getSafeTorDataDir() {
    const normalDir = path.join(TOR_DIR, 'data');
    if (!needsSafePath(normalDir)) return normalDir;
    // ASCII-safe alternatif: C:\ProgramData\whatsapp-sender\tor-data
    const safeDir = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'whatsapp-sender', 'tor-data');
    console.log('[Tor] Non-ASCII yol tespit edildi, güvenli DataDirectory:', safeDir);
    if (!fs.existsSync(safeDir)) fs.mkdirSync(safeDir, { recursive: true });
    return safeDir;
}

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
let successfulChats = new Set();
let processedReplyMessageIds = new Set();
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
    sentNumbers = new Set();
    successfulChats = new Set();
    sentLog.filter(s => s.status === 'başarılı').forEach(s => {
        const normalized = normalizeNumber(s.number);
        if (normalized) sentNumbers.add(normalized);
        const chatId = normalizeChatId(s.chatId || s.from || s.to);
        if (chatId) successfulChats.add(chatId);
        if (!chatId && normalized) {
            successfulChats.add(normalized + '@c.us');
            successfulChats.add(normalized + '@s.whatsapp.net');
        }
    });
}

function normalizeNumber(value) {
    return String(value || '').trim().replace(/\D/g, '');
}

function normalizeChatId(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/@s\.whatsapp\.net$/i.test(raw)) return raw.replace(/@s\.whatsapp\.net$/i, '@c.us').toLowerCase();
    if (/@c\.us$/i.test(raw) || /@g\.us$/i.test(raw)) return raw.toLowerCase();
    const digits = normalizeNumber(raw);
    return digits ? (digits + '@c.us') : raw.toLowerCase();
}

function isTrackedReplyMessage(msg) {
    const fromChatId = normalizeChatId(msg?.from);
    const authorChatId = normalizeChatId(msg?.author);
    const participantChatId = normalizeChatId(msg?._data?.author || msg?._data?.participant || msg?._data?.from);
    const candidates = [fromChatId, authorChatId, participantChatId].filter(Boolean);
    if (candidates.some(chatId => successfulChats.has(chatId))) return true;
    const numberCandidates = candidates.map(normalizeNumber).filter(Boolean);
    return numberCandidates.some(number => sentNumbers.has(number));
}

function buildReplyRecord(msg, accountId, name) {
    const fromChatId = normalizeChatId(msg?.from);
    const authorChatId = normalizeChatId(msg?.author);
    const participantChatId = normalizeChatId(msg?._data?.author || msg?._data?.participant || msg?._data?.from);
    const primaryChatId = fromChatId || authorChatId || participantChatId;
    const number = normalizeNumber(primaryChatId || msg?.from || msg?.author);
    return {
        id: Date.now(),
        number: number || (primaryChatId || '-'),
        name: name,
        message: msg?.body || msg?._data?.caption || '(medya)',
        account: accounts[accountId]?.name || accountId,
        date: new Date().toISOString(),
        chatId: primaryChatId || ''
    };
}

function persistReply(reply) {
    replies.push(reply);
    saveReplies();
    io.emit('reply-received', reply);
}

function logReplyEvent(level, message, extra) {
    remoteLog(level, 'reply', message, extra);
}

function attachReplyListeners(client, accountId) {
    const handleReplyMessage = async (eventName, msg) => {
        try {
            const serializedId = msg?.id?._serialized || msg?.id?.id || `${eventName}-${msg?.from || 'unknown'}-${msg?.timestamp || Date.now()}-${msg?.body || ''}`;
            if (!serializedId) return;
            if (processedReplyMessageIds.has(serializedId)) return;
            if (msg?.fromMe) return;

            const fromChatId = normalizeChatId(msg?.from);
            const authorChatId = normalizeChatId(msg?.author);
            const tracked = isTrackedReplyMessage(msg);
            logReplyEvent('info', `reply-event:${eventName}`, {
                accountId,
                messageId: serializedId,
                from: msg?.from || '',
                author: msg?.author || '',
                fromChatId,
                authorChatId,
                bodyPreview: String(msg?.body || msg?._data?.caption || '').slice(0, 120),
                hasMedia: !!msg?.hasMedia,
                type: msg?.type || msg?._data?.type || '',
                isGroup: /@g\.us$/i.test(String(msg?.from || '')),
                tracked,
                sentNumbersSize: sentNumbers.size,
                successfulChatsSize: successfulChats.size
            });
            if (!tracked) return;

            processedReplyMessageIds.add(serializedId);
            const contact = await msg.getContact().catch(() => null);
            const name = contact?.pushname || contact?.name || normalizeNumber(authorChatId || fromChatId) || fromChatId || 'Bilinmeyen';
            const reply = buildReplyRecord(msg, accountId, name);
            persistReply(reply);
            logReplyEvent('info', 'reply-stored', {
                accountId,
                messageId: serializedId,
                number: reply.number,
                chatId: reply.chatId,
                name,
                bodyPreview: String(reply.message || '').slice(0, 120)
            });
            console.log(`📩 Dönüş: ${reply.number} (${name})`);
        } catch (e) {
            logReplyEvent('error', `reply-handler:${eventName}:${e.message}`, {
                accountId,
                stack: (e.stack || '').slice(0, 800)
            });
        }
    };

    client.on('message', (msg) => handleReplyMessage('message', msg));
    client.on('message_create', (msg) => handleReplyMessage('message_create', msg));
}

function trackSuccessfulChat(chatId, number) {
    const normalizedChatId = normalizeChatId(chatId);
    const normalizedNumber = normalizeNumber(number || chatId);
    if (normalizedChatId) successfulChats.add(normalizedChatId);
    if (normalizedNumber) {
        sentNumbers.add(normalizedNumber);
        successfulChats.add(normalizedNumber + '@c.us');
        successfulChats.add(normalizedNumber + '@s.whatsapp.net');
    }
}

function appendSuccessfulSend(number, accountName, chatId) {
    appendSentLog({
        number,
        account: accountName,
        chatId: normalizeChatId(chatId),
        status: 'başarılı',
        date: new Date().toISOString()
    });
    trackSuccessfulChat(chatId, number);
}

function appendFailedSend(number, accountName, chatId, error) {
    appendSentLog({
        number,
        account: accountName,
        chatId: normalizeChatId(chatId),
        status: 'hata',
        error,
        date: new Date().toISOString()
    });
}

function logSendEvent(level, message, extra) {
    remoteLog(level, 'send', message, extra);
}

function logClientLifecycle(level, message, extra) {
    remoteLog(level, 'client', message, extra);
}

function logRendererEvent(level, message, extra) {
    remoteLog(level, 'renderer', message, extra);
}

app.post('/api/log', (req, res) => {
    const { level, message, extra } = req.body || {};
    logRendererEvent(level || 'info', message || 'renderer-log', extra || {});
    res.json({ success: true });
});

function appendSentLog(entry) {
    sentLog.push(entry);
    saveSentLog();
    io.emit('sent-log-update', sentLog);
}

function emitSkippedNumber(number, total, skippedCount, successCount, errorCount, reason) {
    appendSentLog({
        number,
        account: '-',
        status: SKIPPED_STATUS,
        reason,
        date: new Date().toISOString()
    });
    io.emit('send-progress', {
        number,
        accountId: null,
        accountName: '-',
        status: SKIPPED_STATUS,
        error: reason,
        total,
        skippedCount,
        successCount,
        errorCount
    });
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
    console.log('[Tor] findTorExe — bundled yolu:', bundled, '| mevcut:', fs.existsSync(bundled));
    if (fs.existsSync(bundled)) return bundled;
    try { execSync('where tor.exe', { timeout: 5000, stdio: 'pipe' }); return 'tor.exe'; } catch(e) {}
    const locs = [
        path.join(process.env.LOCALAPPDATA || '', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Tor', 'tor.exe'),
    ].filter(p => p && p.length > 5);
    for (const p of locs) { if (fs.existsSync(p)) return p; }
    // Hiçbir yerde bulunamadı — detaylı log gönder
    let torDirContents = 'YOK';
    try {
        if (fs.existsSync(TOR_DIR)) {
            torDirContents = listDirRecursive(TOR_DIR, 3);
        }
    } catch(e) { torDirContents = 'HATA: ' + e.message; }
    remoteLog('error', 'tor', 'findTorExe: tor.exe bulunamadi', {
        TOR_DIR, bundled,
        torDirExists: fs.existsSync(TOR_DIR),
        torDirContents,
        shortTorDir: getShortPath(TOR_DIR)
    });
    return null;
}

// Dizin içeriğini recursive listele (debug için)
function listDirRecursive(dir, maxDepth, depth) {
    depth = depth || 0;
    if (depth >= maxDepth) return '[...]';
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const result = {};
        for (const e of entries) {
            if (e.isDirectory()) {
                result[e.name + '/'] = listDirRecursive(path.join(dir, e.name), maxDepth, depth + 1);
            } else {
                try { result[e.name] = fs.statSync(path.join(dir, e.name)).size; } catch(_) { result[e.name] = '?'; }
            }
        }
        return result;
    } catch(e) { return 'HATA: ' + e.message; }
}

function startTor() {
    return new Promise((resolve, reject) => {
        if (torProcess && torReady) return resolve(true);
        if (torProcess) stopTor();
        const torExe = findTorExe();
        if (!torExe) {
            remoteLog('error', 'tor', 'startTor: tor.exe bulunamadi', { TOR_DIR, torDirExists: fs.existsSync(TOR_DIR) });
            return reject(new Error('tor.exe bulunamadı'));
        }
        // Güvenli DataDirectory: non-ASCII yollarda ProgramData kullan
        const dataDir = getSafeTorDataDir();
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        // Eski lock dosyasını temizle (önceki crash'ten kalmış olabilir)
        const lockFile = path.join(dataDir, 'lock');
        try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch(e) {}
        const torrcPath = path.join(TOR_DIR, 'torrc');
        // DataDirectory zaten güvenli yolda, ama yine de getShortPath dene
        const safeDataDir = getShortPath(dataDir);
        const cfgLines = [
            'SocksPort 9050',
            'ControlPort 9051',
            'CookieAuthentication 1',
            'DataDirectory "' + safeDataDir.replace(/\\/g, '/') + '"',
        ];
        // GeoIP dosyalarını ara: yeni bundle tor/data/ altında, eski bundle tor/tor/ altında
        const geoipPaths = [
            path.join(TOR_DIR, 'tor', 'geoip'),   // eski bundle
            path.join(TOR_DIR, 'data', 'geoip'),   // yeni bundle (v15+)
        ];
        const geoip6Paths = [
            path.join(TOR_DIR, 'tor', 'geoip6'),
            path.join(TOR_DIR, 'data', 'geoip6'),
        ];
        const geoip = geoipPaths.find(p => fs.existsSync(p));
        const geoip6 = geoip6Paths.find(p => fs.existsSync(p));
        if (geoip) cfgLines.push('GeoIPFile "' + getShortPath(geoip).replace(/\\/g, '/') + '"');
        if (geoip6) cfgLines.push('GeoIPv6File "' + getShortPath(geoip6).replace(/\\/g, '/') + '"');
        fs.writeFileSync(torrcPath, cfgLines.join('\n'));
        const torDir = path.dirname(torExe) !== '.' ? path.dirname(torExe) : TOR_DIR;
        // Tor spawn için de güvenli yollar kullan
        const safeTorExe = getShortPath(torExe);
        const safeTorrcPath = getShortPath(torrcPath);
        const safeTorDir = getShortPath(torDir);
        let output = '', stderrOut = '', done = false;
        console.log('[Tor] Başlatılıyor:', safeTorExe);
        console.log('[Tor] CWD:', safeTorDir);
        console.log('[Tor] torrc:', safeTorrcPath);
        // Detaylı Tor başlatma logları gönder
        remoteLog('info', 'tor', 'startTor baslatiliyor', {
            torExe, safeTorExe, safeTorrcPath, safeTorDir,
            torExeExists: fs.existsSync(torExe),
            safeTorExeExists: fs.existsSync(safeTorExe),
            torrcContent: cfgLines.join('\n'),
            torDirContents: listDirRecursive(TOR_DIR, 3)
        });
        torProcess = spawn(safeTorExe, ['-f', safeTorrcPath], {
            cwd: safeTorDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
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
                // Detaylı hata logunu uzak sunucuya gönder
                remoteLog('error', 'tor', 'startTor basarisiz — ' + errMsg, {
                    exitCode: code,
                    stdout: output.slice(-500),
                    stderr: stderrOut.slice(-500),
                    torExe: safeTorExe,
                    torrcPath: safeTorrcPath,
                    torDir: safeTorDir,
                    torDirContents: listDirRecursive(TOR_DIR, 3)
                });
                reject(new Error(errMsg));
            }
            if (wasReady) io.emit('tor-status', { running: false });
        });
        torProcess.on('error', (err) => {
            torReady = false; torProcess = null;
            console.log('[Tor] Process error:', err.message);
            remoteLog('error', 'tor', 'spawn error: ' + err.message, {
                torExe: safeTorExe, code: err.code, errno: err.errno
            });
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
        // Cookie dosyasını güvenli DataDirectory'de ara
        const safeDataDir = getSafeTorDataDir();
        const cookiePaths = [
            path.join(safeDataDir, 'control_auth_cookie'),
            path.join(TOR_DIR, 'data', 'control_auth_cookie'),
        ];
        const cookiePath = cookiePaths.find(p => fs.existsSync(p));
        if (!cookiePath) return reject(new Error('Cookie dosyası bulunamadı'));
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
                if (findTorExe()) {
                    remoteLog('info', 'tor', 'downloadTor basarili v' + ver, {
                        TOR_DIR, torDirContents: listDirRecursive(TOR_DIR, 3)
                    });
                    return { success: true, message: 'Tor başarıyla indirildi (v' + ver + ')' };
                }
                // İndirme sonrası tor.exe bulunamadı
                remoteLog('warn', 'tor', 'downloadTor: arsiv acildi ama tor.exe bulunamadi v' + ver, {
                    TOR_DIR, torDirContents: listDirRecursive(TOR_DIR, 3)
                });
            }
        } catch(e) {
            console.log('[Tor DL] v' + ver + ' başarısız:', e.message);
        }
        try { fs.unlinkSync(archivePath); } catch(e) {}
    }
    remoteLog('error', 'tor', 'downloadTor: tum versiyonlar basarisiz', { TOR_DIR, versions: versions.slice(0, 10) });
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
        console.log(`[Tor DL] Sistem tar ile açılıyor: ${archive} -> ${destDir}`);
        // Windows tar complains about -C with backslashes. Best to use cwd.
        exec(utf8Cmd(`tar xzf "${path.basename(archive)}"`), { cwd: path.dirname(archive), timeout: 60000 }, (err, stdout, stderr) => {
            if (!err && findTorExe()) {
                console.log('[Tor DL] tar başarıyla tamamlandı.');
                return resolve();
            }
            console.log('[Tor DL] Sistem tar başarısız:', err?.message || stderr);
            console.log('[Tor DL] Node.js ile açılıyor...');
            try {
                const input = fs.createReadStream(archive);
                const gunzip = zlib.createGunzip();
                const chunks = [];
                input.pipe(gunzip);
                gunzip.on('data', (c) => chunks.push(c));
                gunzip.on('end', () => {
                    try {
                        const tarBuf = Buffer.concat(chunks);
                        extractTarBuffer(tarBuf, destDir);
                        resolve();
                    } catch(e) {
                        reject(new Error('Node.js extraction error: ' + e.message));
                    }
                });
                gunzip.on('error', e => reject(new Error('Gunzip error: ' + e.message)));
                input.on('error', e => reject(new Error('File read error: ' + e.message)));
            } catch(e) {
                reject(new Error('Extraction setup error: ' + e.message));
            }
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
            logClientLifecycle('info', 'client-ready', {
                accountId,
                pushname: client.info?.pushname || '',
                wid: client.info?.wid?._serialized || ''
            });
            console.log(`✅ Hesap bağlandı: ${accountId}`);
        }
    });

    attachReplyListeners(client, accountId);
    logClientLifecycle('info', 'reply-listeners-attached', { accountId });

    client.on('change_state', (state) => {
        logClientLifecycle('info', 'client-change-state', { accountId, state });
    });

    client.on('auth_failure', (message) => {
        logClientLifecycle('error', 'client-auth-failure', { accountId, message: message || '' });
        if (accounts[accountId]) {
            accounts[accountId].status = 'auth-hatası';
            io.emit('account-update', getAccountInfo(accountId));
        }
    });

    client.on('disconnected', (reason) => {
        logClientLifecycle('warn', 'client-disconnected', { accountId, reason: reason || '' });
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

    client.on('error', (err) => {
        logClientLifecycle('error', 'client-error', {
            accountId,
            message: err?.message || String(err),
            stack: (err?.stack || '').slice(0, 800)
        });
    });

    client.on('loading_screen', (percent, message) => {
        logClientLifecycle('info', 'client-loading-screen', { accountId, percent, message: message || '' });
    });

    client.on('qr', () => {
        logClientLifecycle('info', 'client-qr', { accountId });
    });

    client.on('authenticated', () => {
        logClientLifecycle('info', 'client-authenticated', { accountId });
        if (accounts[accountId]) {
            accounts[accountId].status = 'doğrulandı';
            io.emit('account-update', getAccountInfo(accountId));
        }
    });

    client.on('message_ack', (msg, ack) => {
        logClientLifecycle('info', 'client-message-ack', {
            accountId,
            ack,
            id: msg?.id?._serialized || msg?.id?.id || '',
            to: msg?.to || '',
            from: msg?.from || ''
        });
    });

    client.on('message_revoke_everyone', (after, before) => {
        logClientLifecycle('warn', 'client-message-revoked', {
            accountId,
            afterId: after?.id?._serialized || '',
            beforeId: before?.id?._serialized || ''
        });
    });

    client.on('group_join', (notification) => {
        logClientLifecycle('info', 'client-group-join', {
            accountId,
            chatId: notification?.chatId || '',
            author: notification?.author || ''
        });
    });

    client.on('group_leave', (notification) => {
        logClientLifecycle('info', 'client-group-leave', {
            accountId,
            chatId: notification?.chatId || '',
            author: notification?.author || ''
        });
    });

    client.on('contact_changed', (message, oldId, newId, isContact) => {
        logClientLifecycle('info', 'client-contact-changed', {
            accountId,
            oldId: oldId || '',
            newId: newId || '',
            isContact: !!isContact,
            messageId: message?.id?._serialized || ''
        });
    });

    client.on('incoming_call', (call) => {
        logClientLifecycle('info', 'client-incoming-call', {
            accountId,
            from: call?.from || '',
            canHandleLocally: !!call
        });
    });

    client.initialize().catch(err => {
        logClientLifecycle('error', 'client-initialize-failed', {
            accountId,
            message: err?.message || String(err),
            stack: (err?.stack || '').slice(0, 800)
        });
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
        exec(utf8Cmd(cmd), { timeout: timeoutMs || 15000 }, (err, stdout, stderr) => {
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

    const { numbers, message, messages: msgList, messageMode, delayMin, delayMax, burstCount, burstPause, antiSpam, speedyMode } = req.body;

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

    const seenInBatch = new Set();
    const validNumbers = [];
    let skippedCount = 0;

    numbers.forEach(rawNumber => {
        const normalized = normalizeNumber(rawNumber);
        if (normalized.length < 10) return;
        if (seenInBatch.has(normalized)) {
            skippedCount++;
            emitSkippedNumber(normalized, numbers.length, skippedCount, 0, 0, 'Aynı listede tekrar numara');
            return;
        }
        seenInBatch.add(normalized);
        if (sentNumbers.has(normalized)) {
            skippedCount++;
            emitSkippedNumber(normalized, numbers.length, skippedCount, 0, 0, 'Önceden başarılı gönderilmiş');
            return;
        }
        validNumbers.push(normalized);
    });

    if (validNumbers.length === 0) {
        return res.status(400).json({ error: 'Gönderilecek yeni geçerli numara bulunamadı' });
    }

    const opts = {
        delayMin:   Math.max(1000,  parseInt(delayMin)  || 15000),
        delayMax:   Math.max(2000,  parseInt(delayMax)  || 45000),
        burstCount: Math.max(1,     parseInt(burstCount) || 10),
        burstPause: Math.max(60000, parseInt(burstPause) || 300000),
        antiSpam: antiSpam || { warmup: true, typing: true, offline: true, torIp: true },
        speedyMode: !!speedyMode,
        skippedCount
    };
    if (opts.speedyMode) {
        opts.delayMin = SPEEDY_MODE_DEFAULTS.delayMin;
        opts.delayMax = SPEEDY_MODE_DEFAULTS.delayMax;
        opts.antiSpam = { ...SPEEDY_MODE_DEFAULTS.antiSpam };
    } else if (opts.delayMax < opts.delayMin) {
        opts.delayMax = opts.delayMin + 5000;
    }

    res.json({ success: true, total: validNumbers.length, skippedCount });

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

// ─── Core send logic (Anti-Spam Enhanced) ───────────────────────────────────

async function sendMessages(numbers, messageList, messageMode, accountIds, opts) {
    io.emit('send-started', { total: numbers.length, skippedCount: opts.skippedCount || 0 });

    let successCount = 0;
    let errorCount   = 0;
    let skippedCount = opts.skippedCount || 0;
    let sentThisBurst = 0;
    let totalSent = 0;
    let pausedForAccounts = false;

    async function waitForConnectedAccount(index) {
        while (!stopRequested) {
            const alive = Object.keys(accounts).filter(id => accounts[id]?.status === 'bağlı' && accounts[id]?.client);
            if (alive.length > 0) {
                if (pausedForAccounts) {
                    pausedForAccounts = false;
                    io.emit('send-resumed', { index, total: numbers.length, accountCount: alive.length });
                }
                return alive;
            }
            if (!pausedForAccounts) {
                pausedForAccounts = true;
                io.emit('send-paused', { index, total: numbers.length, reason: 'no-accounts' });
                io.emit('send-log', { text: '⏸ Bağlı hesap kalmadı — yeni hesap bekleniyor', type: 'warn' });
            }
            await sleep(SEND_PAUSE_POLL_MS);
        }
        return [];
    }

    function getAliveAccounts() {
        return Object.keys(accounts).filter(id => accounts[id]?.status === 'bağlı' && accounts[id]?.client);
    }

    function emitProgress(payload) {
        io.emit('send-progress', {
            total: numbers.length,
            successCount,
            errorCount,
            skippedCount,
            ...payload
        });
    }

    function emitStopped(index) {
        io.emit('send-stopped', { index, total: numbers.length, successCount, errorCount, skippedCount });
    }

    function emitCompleted() {
        io.emit('send-complete', { total: numbers.length, successCount, errorCount, skippedCount });
    }

    // ─── Akıllı warm-up: İlk mesajlar çok daha yavaş ───
    const WARMUP_COUNT = 5;     // İlk 5 mesaj warm-up fazında
    const WARMUP_MULTIPLIER = 3; // Warm-up'ta 3x daha yavaş

    function getDelay(index) {
        let baseMin = opts.delayMin;
        let baseMax = opts.delayMax;

        if (opts.antiSpam.warmup && index < WARMUP_COUNT) {
            // Warm-up: kademeli hızlanma (ilk mesaj 3x, 2. mesaj 2.5x, ...)
            const factor = WARMUP_MULTIPLIER - (index * 0.5 * (WARMUP_MULTIPLIER - 1) / WARMUP_COUNT);
            baseMin = Math.round(baseMin * Math.max(1.5, factor));
            baseMax = Math.round(baseMax * Math.max(1.5, factor));
            io.emit('send-log', { text: `🔥 Warm-up (${index + 1}/${WARMUP_COUNT}) — Bekleme: ${Math.round(baseMin/1000)}-${Math.round(baseMax/1000)}sn`, type: 'info' });
        }

        return randomDelay(baseMin, baseMax);
    }

    // ─── Mesaj uzunluğuna göre yazma süresini hesapla ───
    function getTypingDuration(msgText) {
        // Ortalama insan yazma hızı: ~200 karakter/dakika (3.3 karakter/saniye)
        // Ama whatsapp'ta daha hızlı yazıyoruz, ~6 karakter/saniye diyelim
        const charCount = msgText.length;
        const baseMs = Math.round(charCount / 6 * 1000); // karakter sayısı / hız
        // Min 1.5 saniye, max 12 saniye
        const typingMs = Math.max(1500, Math.min(12000, baseMs));
        // ±30% rastgelelik ekle
        const variation = typingMs * 0.3;
        return Math.round(typingMs + (Math.random() * variation * 2 - variation));
    }

    function pickAccount() {
        const alive = getAliveAccounts();
        if (alive.length === 0) return null;
        return alive[totalSent % alive.length];
    }

    for (let i = 0; i < numbers.length; i++) {
        if (stopRequested) {
            emitStopped(i);
            return;
        }

        const aliveAccounts = await waitForConnectedAccount(i);
        if (stopRequested || aliveAccounts.length === 0) {
            emitStopped(i);
            return;
        }

        const accountId = pickAccount();
        if (!accountId) {
            emitStopped(i);
            return;
        }
        const client = accounts[accountId]?.client;
        if (!client) { errorCount++; continue; }

        const number = numbers[i];
        const chatId = `${number}@c.us`;

        try {
            // 1) Numaranın gerçek chatId'sini al
            let realChatId = chatId;
            try {
                const numberId = await client.getNumberId(number);
                if (numberId) realChatId = numberId._serialized;
            } catch(_) {}

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
            } catch(_) {}

            // 3) Mesaj seç
            const msgText = messageMode === 'random'
                ? messageList[Math.floor(Math.random() * messageList.length)]
                : messageList[i % messageList.length];

            // 4) İnsan benzeri sohbet açma + yazma simülasyonu
            try {
                const chat = await client.getChatById(realChatId);

                // Sohbeti aç, göründü yap
                await chat.sendSeen();
                await sleep(randomDelay(500, 1200));

                if (opts.antiSpam.typing) {
                    // Yazıyor simülasyonu — mesaj uzunluğuna göre süre
                    const typeDuration = getTypingDuration(msgText);
                    io.emit('send-log', { text: `⌨️ Yazıyor simülasyonu: ${Math.round(typeDuration/1000)}sn (${msgText.length} karakter)`, type: 'info' });
                    await chat.sendStateTyping();
                    await sleep(typeDuration);
                    await chat.clearState();
                } else {
                    await sleep(randomDelay(1000, 2000));
                }
            } catch(_) {}

            // 5) Mesajı gönder
            await client.sendMessage(realChatId, msgText);
            logSendEvent('info', 'send-success', {
                accountId,
                number,
                chatId: normalizeChatId(realChatId),
                messagePreview: String(msgText || '').slice(0, 120),
                index: i + 1,
                total: numbers.length
            });
            successCount++;
            sentThisBurst++;
            totalSent++;

            // Gönderim kaydını logla
            appendSuccessfulSend(number, accounts[accountId]?.name || accountId, realChatId);

            emitProgress({
                number, accountId,
                accountName: accounts[accountId]?.name || accountId,
                status: 'başarılı',
                index: i + 1
            });
        } catch (err) {
            errorCount++;
            totalSent++;
            logSendEvent('error', 'send-failed', {
                accountId,
                number,
                chatId: normalizeChatId(chatId),
                error: err.message,
                stack: (err.stack || '').slice(0, 800),
                index: i + 1,
                total: numbers.length
            });

            appendFailedSend(number, accounts[accountId]?.name || accountId, chatId, err.message);

            emitProgress({
                number, accountId,
                accountName: accounts[accountId]?.name || accountId,
                status: 'hata', error: err.message,
                index: i + 1
            });
        }

        if (i < numbers.length - 1 && !stopRequested) {
            // Burst mola
            if (sentThisBurst > 0 && sentThisBurst % opts.burstCount === 0) {
                const pauseSec = Math.round(opts.burstPause / 1000);
                console.log(`⏸ ${opts.burstCount} mesaj gönderildi, ${pauseSec}sn mola...`);
                io.emit('send-pause', { seconds: pauseSec, index: i + 1, total: numbers.length });

                // ─── Burst molasında Tor IP değiştir (varsa) ───
                if (torReady && opts.antiSpam.torIp) {
                    try {
                        await torNewIdentity();
                        io.emit('send-log', { text: '🔄 Burst molası — Tor yeni IP alındı', type: 'info' });
                    } catch(e) {
                        io.emit('send-log', { text: '⚠️ Tor IP değiştirilemedi: ' + e.message, type: 'warn' });
                    }
                }

                // ─── Online/offline simülasyonu: molada çevrimdışı ol ───
                if (opts.antiSpam.offline) {
                    try {
                        const accId = pickAccount();
                        if (accId && accounts[accId]?.client) {
                            await accounts[accId].client.sendPresenceUnavailable();
                            io.emit('send-log', { text: '📴 Çevrimdışı olundu (mola)', type: 'info' });
                        }
                    } catch(_) {}
                }

                await sleep(opts.burstPause);
                if (stopRequested) break;

                // Moladan sonra tekrar online ol
                if (opts.antiSpam.offline) {
                    try {
                        const accId = pickAccount();
                        if (accId && accounts[accId]?.client) {
                            await accounts[accId].client.sendPresenceAvailable();
                            io.emit('send-log', { text: '📱 Tekrar çevrimiçi', type: 'info' });
                        }
                    } catch(_) {}
                }

                sentThisBurst = 0;
            } else {
                // ─── Normal bekleme (warm-up dahil) ───
                const wait = getDelay(i);

                // ─── Rastgele offline/online: %20 ihtimalle kısa offline ol ───
                if (opts.antiSpam.offline && Math.random() < 0.2) {
                    const offlineDuration = randomDelay(8000, 25000);
                    io.emit('send-log', { text: `📴 Kısa offline (${Math.round(offlineDuration/1000)}sn) — insan davranışı`, type: 'info' });
                    try {
                        const accId = pickAccount();
                        if (accId && accounts[accId]?.client) {
                            await accounts[accId].client.sendPresenceUnavailable();
                        }
                    } catch(_) {}

                    await sleep(offlineDuration);

                    try {
                        const accId = pickAccount();
                        if (accId && accounts[accId]?.client) {
                            await accounts[accId].client.sendPresenceAvailable();
                        }
                    } catch(_) {}
                }

                await sleep(wait);
            }
        }
    }

    emitCompleted();
    console.log(`📨 Gönderim tamamlandı — Başarılı: ${successCount}, Hatalı: ${errorCount}, Atlanan: ${skippedCount}`);
}

// ─── Unhandled errors — sunucunun crash olmasını önle ───────────────────────

process.on('uncaughtException', (err) => {
    console.error('⚠️ Yakalanmamış hata (sunucu çalışmaya devam ediyor):', err.message);
    remoteLog('error', 'app', 'uncaughtException: ' + err.message, { stack: (err.stack || '').slice(0, 500) });
});
process.on('unhandledRejection', (err) => {
    console.error('⚠️ Yakalanmamış promise hatası:', err?.message || err);
    remoteLog('error', 'app', 'unhandledRejection: ' + (err?.message || String(err)), { stack: (err?.stack || '').slice(0, 500) });
});

// ─── Start server ────────────────────────────────────────────────────────────

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`\n✅ Sunucu başlatıldı → http://localhost:${PORT}`);
    console.log('Tarayıcınızda bu adresi açın.\n');
    // Uygulama başlatıldığında uzak log gönder
    remoteLog('info', 'app', 'Uygulama baslatildi', {
        port: PORT,
        torInstalled: !!findTorExe(),
        torDir: TOR_DIR,
        torDirExists: fs.existsSync(TOR_DIR),
        torDirContents: fs.existsSync(TOR_DIR) ? listDirRecursive(TOR_DIR, 3) : 'YOK'
    });
});
