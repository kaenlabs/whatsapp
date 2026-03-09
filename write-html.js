const fs = require('fs');
const path = require('path');

const html = `<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Mesaj G\u00F6ndericisi</title>
    <script src="/socket.io/socket.io.js"><\/script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
            --bg:            #080810;
            --panel:         #0f0f1e;
            --panel2:        #13132a;
            --border:        #2a1a5e;
            --border-bright: #5b21b6;
            --purple:        #7c3aed;
            --purple-l:      #a855f7;
            --purple-xl:     #c084fc;
            --glow:          rgba(168, 85, 247, 0.45);
            --glow-s:        rgba(124, 58, 237, 0.18);
            --text:          #e2e8f0;
            --muted:         #94a3b8;
            --dim:           #4b5563;
            --ok:            #10b981;
            --err:           #ef4444;
            --warn:          #f59e0b;
            --inp:           #1a1930;
            --inp-border:    #372d6b;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: var(--bg);
            color: var(--text);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .header {
            background: linear-gradient(135deg, #150930 0%, #0a0a18 100%);
            border-bottom: 1px solid var(--border-bright);
            box-shadow: 0 0 30px var(--glow);
            padding: 12px 20px;
            display: flex;
            align-items: center;
            gap: 14px;
            flex-shrink: 0;
        }
        .header-icon { font-size: 28px; filter: drop-shadow(0 0 8px var(--purple-l)); }
        .header h1 {
            font-size: 17px; font-weight: 800; letter-spacing: 0.6px;
            color: var(--purple-xl);
            text-shadow: 0 0 20px var(--glow);
        }
        .header-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }

        .main {
            display: grid;
            grid-template-columns: 270px 1fr 330px;
            grid-template-rows: 1fr 190px;
            gap: 10px;
            padding: 10px;
            flex: 1;
            overflow: hidden;
            min-height: 0;
        }

        .panel {
            background: var(--panel);
            border: 1px solid var(--border);
            border-radius: 14px;
            box-shadow: 0 0 18px var(--glow-s), inset 0 1px 0 rgba(168,85,247,0.08);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .panel-header {
            background: linear-gradient(135deg, #1c0a4a 0%, #0e0e22 100%);
            border-bottom: 1px solid var(--border);
            color: var(--purple-l);
            padding: 9px 14px;
            font-size: 12px; font-weight: 800;
            letter-spacing: 1px; text-transform: uppercase;
            text-shadow: 0 0 12px var(--glow);
            flex-shrink: 0;
            display: flex; align-items: center; justify-content: space-between;
        }
        .panel-body {
            flex: 1; overflow-y: auto; padding: 12px; min-height: 0;
        }
        .panel-bottom { grid-column: 1 / -1; }

        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--purple); border-radius: 4px; }

        input, textarea, select {
            background: var(--inp);
            border: 1px solid var(--inp-border);
            border-radius: 8px;
            color: var(--text);
            font-size: 13px; font-family: inherit;
            padding: 8px 10px; width: 100%;
            outline: none;
            transition: border-color 0.2s, box-shadow 0.2s;
        }
        input:focus, textarea:focus, select:focus {
            border-color: var(--purple-l);
            box-shadow: 0 0 10px var(--glow);
        }
        textarea { resize: vertical; }
        select option { background: #1a1930; }

        label {
            display: block; font-size: 11px; color: var(--muted);
            margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;
        }
        .fg { margin-bottom: 9px; }
        .fg2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

        .btn {
            border: none; border-radius: 8px; cursor: pointer;
            font-size: 13px; font-family: inherit; font-weight: 700;
            padding: 8px 16px;
            transition: all 0.18s;
            display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        }
        .btn-primary {
            background: linear-gradient(135deg, var(--purple), #4c1d95);
            color: #fff; border: 1px solid var(--purple-l);
            box-shadow: 0 0 10px var(--glow-s);
        }
        .btn-primary:hover { box-shadow: 0 0 22px var(--glow); transform: translateY(-1px); }
        .btn-success {
            background: linear-gradient(135deg, #059669, #065f46);
            color: #fff; border: 1px solid var(--ok);
            box-shadow: 0 0 10px rgba(16,185,129,0.2);
        }
        .btn-success:hover { box-shadow: 0 0 20px rgba(16,185,129,0.45); transform: translateY(-1px); }
        .btn-danger {
            background: linear-gradient(135deg, #dc2626, #991b1b);
            color: #fff; border: 1px solid var(--err);
        }
        .btn-danger:hover { box-shadow: 0 0 16px rgba(239,68,68,0.45); transform: translateY(-1px); }
        .btn-ghost {
            background: transparent; color: var(--muted);
            border: 1px solid #2e2b50;
        }
        .btn-ghost:hover { border-color: var(--purple-l); color: var(--purple-l); background: var(--glow-s); }
        .btn-sm { padding: 4px 10px; font-size: 12px; }
        .btn-full { width: 100%; }
        .btn:disabled { opacity: 0.35; cursor: not-allowed; transform: none !important; box-shadow: none !important; }

        #accounts-list { display: flex; flex-direction: column; gap: 7px; }
        .account-item {
            background: #14142e;
            border: 1px solid var(--border);
            border-left: 3px solid var(--border);
            border-radius: 10px; padding: 9px 11px;
            transition: border-color 0.3s, box-shadow 0.3s;
        }
        .account-item.connected {
            border-left-color: var(--ok);
            box-shadow: 0 0 10px rgba(16,185,129,0.12);
        }
        .account-item.pending { border-left-color: var(--warn); }
        .account-item.error   { border-left-color: var(--err); }

        .account-row { display: flex; align-items: center; gap: 8px; }
        .dot {
            width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
            background: var(--dim);
        }
        .dot.connected { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
        .dot.pending   { background: var(--warn); }
        .dot.error     { background: var(--err); }
        .account-name  { font-size: 13px; font-weight: 700; flex: 1; }
        .account-status-text { font-size: 11px; color: var(--muted); margin-top: 3px; margin-left: 15px; }
        .pair-code-box {
            background: #1a0d40; border: 1px solid var(--purple);
            border-radius: 8px; padding: 8px; margin-top: 8px; text-align: center;
            font-size: 26px; font-weight: 900; letter-spacing: 8px;
            color: var(--purple-xl); font-family: 'Consolas', monospace;
            text-shadow: 0 0 18px var(--glow);
        }
        .pair-code-hint { font-size: 11px; color: var(--muted); text-align: center; margin-top: 4px; }

        .add-acc {
            border-top: 1px solid var(--border);
            padding: 11px 12px; flex-shrink: 0;
        }
        .add-acc-title { font-size: 11px; color: var(--muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }

        #messages-list { display: flex; flex-direction: column; gap: 8px; }
        .msg-card {
            background: #14142e; border: 1px solid var(--border);
            border-radius: 10px; padding: 10px 12px;
            cursor: pointer;
            transition: border-color 0.2s, box-shadow 0.2s;
        }
        .msg-card:hover { border-color: var(--purple); box-shadow: 0 0 10px var(--glow-s); }
        .msg-card-head {
            display: flex; align-items: center; justify-content: space-between;
            margin-bottom: 5px;
        }
        .msg-title { font-size: 13px; font-weight: 700; color: var(--purple-l); }
        .msg-preview {
            font-size: 12px; color: var(--muted);
            white-space: pre-wrap; word-break: break-word;
            display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
            overflow: hidden; max-height: 36px;
        }
        .msg-actions { display: flex; gap: 4px; }

        .modal-overlay {
            display: none; position: fixed; inset: 0;
            background: rgba(0,0,0,0.75); z-index: 200;
            align-items: center; justify-content: center;
            backdrop-filter: blur(5px);
        }
        .modal-overlay.active { display: flex; }
        .modal {
            background: var(--panel2); border: 1px solid var(--purple);
            border-radius: 16px; padding: 24px; width: 480px; max-width: 92vw;
            box-shadow: 0 0 50px var(--glow), 0 0 100px rgba(124,58,237,0.15);
            animation: pop 0.18s ease;
        }
        @keyframes pop { from { transform: scale(0.93); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        .modal-title {
            font-size: 15px; font-weight: 800; color: var(--purple-xl);
            text-shadow: 0 0 12px var(--glow); margin-bottom: 16px;
        }
        .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }

        .msg-preview-box {
            background: var(--inp); border: 1px solid var(--inp-border);
            border-radius: 8px; padding: 10px; font-size: 12px;
            color: var(--muted); min-height: 54px; max-height: 90px;
            overflow-y: auto; white-space: pre-wrap; word-break: break-word;
            margin-bottom: 9px;
        }

        .stats-bar {
            display: flex; gap: 18px; padding: 7px 14px;
            background: #0a0a16; border-bottom: 1px solid var(--border);
            flex-shrink: 0; align-items: center;
        }
        .stat { font-size: 12px; display: flex; align-items: center; gap: 5px; }
        .stat-n { font-weight: 800; color: var(--purple-xl); }
        .stat-l { color: var(--muted); }
        .prog-wrap { flex: 1; }
        .prog-track { background: #1a1930; border-radius: 4px; height: 5px; overflow: hidden; }
        .prog-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--purple), var(--purple-xl));
            box-shadow: 0 0 8px var(--glow);
            transition: width 0.35s; width: 0%;
        }

        .log-wrap { font-family: 'Consolas', monospace; font-size: 12px; height: 100%; overflow-y: auto; }
        .le { padding: 2px 0; border-bottom: 1px solid #12122a; line-height: 1.45; }
        .le.ok   { color: var(--ok); }
        .le.err  { color: var(--err); }
        .le.info { color: var(--purple-l); }
        .le.warn { color: var(--warn); }
        .le.pause{ color: #60a5fa; }

        .empty {
            text-align: center; padding: 24px 12px;
            color: var(--dim); font-size: 13px;
        }
        .empty-icon { font-size: 34px; margin-bottom: 8px; }

        .divider { height: 1px; background: linear-gradient(to right, transparent, var(--border), transparent); margin: 8px 0; }

        .badge-ok  { background: rgba(16,185,129,0.15); color: var(--ok); border-radius: 20px; padding: 1px 7px; font-size: 10px; font-weight: 700; }
        .badge-err { background: rgba(239,68,68,0.15);  color: var(--err); border-radius: 20px; padding: 1px 7px; font-size: 10px; font-weight: 700; }
    </style>
</head>
<body>

<div class="header">
    <div class="header-icon">\u{1F4AC}</div>
    <div>
        <h1>WhatsApp Mesaj G\u00F6ndericisi</h1>
        <div class="header-sub">\u00C7oklu hesap \u2022 Kay\u0131tl\u0131 mesajlar \u2022 Toplu g\u00F6nderim</div>
    </div>
</div>

<div class="main">

    <div class="panel">
        <div class="panel-header">
            <span>\u26A1 Hesaplar</span>
            <span id="acc-count" style="font-size:11px;color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0">0 hesap</span>
        </div>
        <div class="panel-body">
            <div id="accounts-list">
                <div class="empty"><div class="empty-icon">\u{1F4F1}</div>Hen\u00FCz hesap eklenmedi</div>
            </div>
        </div>
        <div class="add-acc">
            <div class="add-acc-title">Yeni Hesap Ekle</div>
            <div class="fg">
                <label>\u0130sim</label>
                <input type="text" id="acc-name" placeholder="Numara 1, Kampanya, vb.">
            </div>
            <div class="fg">
                <label>Telefon Numaras\u0131</label>
                <input type="text" id="acc-phone" placeholder="905551234567" inputmode="numeric">
            </div>
            <button class="btn btn-primary btn-full" onclick="addAccount()">\u2795 Hesap Ekle</button>
        </div>
    </div>

    <div class="panel">
        <div class="panel-header">
            <span>\u{1F4DD} Kay\u0131tl\u0131 Mesajlar</span>
            <button class="btn btn-primary btn-sm" onclick="openMsgModal()">+ Yeni</button>
        </div>
        <div class="panel-body">
            <div id="messages-list">
                <div class="empty">
                    <div class="empty-icon">\u2709\uFE0F</div>
                    Kay\u0131tl\u0131 mesaj yok<br>
                    <small style="color:var(--dim)">"Yeni" butonuyla ekleyin</small>
                </div>
            </div>
        </div>
    </div>

    <div class="panel">
        <div class="panel-header"><span>\u{1F680} G\u00F6nderim</span></div>
        <div class="panel-body">

            <div class="fg">
                <label>G\u00F6nderilecek Mesaj</label>
                <select id="sel-msg" onchange="onMsgSelect()">
                    <option value="">\u2014 Mesaj se\u00E7in \u2014</option>
                </select>
            </div>
            <div class="msg-preview-box" id="msg-preview">Mesaj se\u00E7ilmedi</div>

            <div class="divider"></div>

            <div class="fg">
                <label>Numara Listesi <small style="color:var(--dim)">(her sat\u0131ra bir numara)</small></label>
                <textarea id="numbers" rows="5" placeholder="905551234567&#10;905559876543&#10;..."></textarea>
            </div>

            <div class="divider"></div>

            <div class="fg2">
                <div class="fg"><label>Min Bekleme (sn)</label><input type="number" id="d-min" value="15" min="1"></div>
                <div class="fg"><label>Max Bekleme (sn)</label><input type="number" id="d-max" value="45" min="2"></div>
            </div>
            <div class="fg2">
                <div class="fg"><label>Burst (ka\u00E7 mesajda)</label><input type="number" id="b-count" value="10" min="1"></div>
                <div class="fg"><label>Burst Molas\u0131 (dk)</label><input type="number" id="b-pause" value="5" min="1"></div>
            </div>

            <div style="display:flex;gap:8px;margin-top:6px;">
                <button class="btn btn-success btn-full" id="btn-send" onclick="startSend()">\u25B6 Ba\u015Flat</button>
                <button class="btn btn-danger" id="btn-stop" onclick="stopSend()" disabled style="min-width:90px;">\u23F9 Durdur</button>
            </div>
        </div>
    </div>

    <div class="panel panel-bottom">
        <div class="stats-bar">
            <div class="stat"><span class="stat-l">\u0130lerleme:</span><span class="stat-n" id="s-prog">0 / 0</span></div>
            <div class="stat"><span class="stat-l">Ba\u015Far\u0131l\u0131:</span><span class="stat-n" id="s-ok" style="color:var(--ok)">0</span></div>
            <div class="stat"><span class="stat-l">Hatal\u0131:</span><span class="stat-n" id="s-err" style="color:var(--err)">0</span></div>
            <div class="prog-wrap">
                <div class="prog-track"><div class="prog-fill" id="prog-fill"></div></div>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="clearLog()">\u{1F5D1} Temizle</button>
        </div>
        <div class="panel-body" style="padding:8px 12px;">
            <div class="log-wrap" id="log"></div>
        </div>
    </div>

</div>

<div class="modal-overlay" id="msg-modal">
    <div class="modal">
        <div class="modal-title" id="modal-title">Yeni Mesaj</div>
        <input type="hidden" id="modal-mid">
        <div class="fg">
            <label>Ba\u015Fl\u0131k</label>
            <input type="text" id="modal-mtitle" placeholder="Mesaj ba\u015Fl\u0131\u011F\u0131 (\u00F6rn: Tan\u0131t\u0131m Mesaj\u0131)">
        </div>
        <div class="fg">
            <label>Mesaj \u0130\u00E7eri\u011Fi</label>
            <textarea id="modal-mcontent" rows="7" placeholder="G\u00F6nderilecek mesaj i\u00E7eri\u011Fi..."></textarea>
        </div>
        <div class="modal-actions">
            <button class="btn btn-ghost" onclick="closeMsgModal()">\u0130ptal</button>
            <button class="btn btn-primary" onclick="saveMsg()">\u{1F4BE} Kaydet</button>
        </div>
    </div>
</div>

<script>
    const socket = io();
    let accounts = {};
    let messages = [];
    let isSending = false;

    socket.on('account-update', data => {
        if (accounts[data.id]) Object.assign(accounts[data.id], data);
        renderAccounts();
    });
    socket.on('account-removed', ({ id }) => { delete accounts[id]; renderAccounts(); });
    socket.on('pairing-code', ({ id, code }) => {
        if (accounts[id]) accounts[id].pairingCode = code;
        renderAccounts();
        log('Pairing kodu geldi (' + id + '): ' + code, 'info');
    });
    socket.on('pairing-error', ({ id, error }) => log('Pairing hatas\\u0131 (' + id + '): ' + error, 'err'));
    socket.on('qr-done', ({ id }) => {
        if (accounts[id]) accounts[id].pairingCode = null;
        renderAccounts();
        log('Hesap ba\\u011Fland\\u0131: ' + id, 'info');
    });

    socket.on('send-started', ({ total }) => {
        isSending = true; setSendBtns();
        setStat(0, total, 0, 0);
        log('G\\u00F6nderim ba\\u015Flad\\u0131 \\u2014 ' + total + ' numara', 'info');
    });
    socket.on('send-progress', data => {
        const ok = data.status === 'ba\\u015Far\\u0131l\\u0131';
        log((ok ? '\\u2713' : '\\u2717') + ' ' + data.number + '  via ' + data.accountName + (!ok ? '  ' + (data.error || '') : ''), ok ? 'ok' : 'err');
        setStat(data.index, data.total, data.successCount, data.errorCount);
    });
    socket.on('send-pause', ({ seconds, index, total }) => {
        setStat(index, total);
        log('\\u23F8 ' + seconds + 'sn mola...', 'pause');
    });
    socket.on('send-complete', ({ total, successCount: s, errorCount: e }) => {
        isSending = false; setSendBtns();
        setStat(total, total, s, e);
        log('Tamamland\\u0131 \\u2014 Ba\\u015Far\\u0131l\\u0131: ' + s + '  Hatal\\u0131: ' + e, 'info');
    });
    socket.on('send-stopped', ({ index, total, successCount: s, errorCount: e }) => {
        isSending = false; setSendBtns();
        log('Durduruldu \\u2014 ' + index + '/' + total, 'warn');
    });

    async function loadAccounts() {
        const r = await fetch('/api/accounts');
        const list = await r.json();
        accounts = {};
        list.forEach(a => accounts[a.id] = a);
        renderAccounts();
    }

    function renderAccounts() {
        const el = document.getElementById('accounts-list');
        const ids = Object.keys(accounts);
        document.getElementById('acc-count').textContent = ids.length + ' hesap';
        if (!ids.length) {
            el.innerHTML = '<div class="empty"><div class="empty-icon">\\u{1F4F1}</div>Hen\\u00FCz hesap eklenmedi</div>';
            return;
        }
        el.innerHTML = ids.map(id => {
            const a = accounts[id];
            const cls = a.status === 'ba\\u011Fl\\u0131' ? 'connected'
                      : (a.status === 'hata' || a.status === 'auth-hatas\\u0131') ? 'error' : 'pending';
            const code = a.pairingCode
                ? '<div class="pair-code-box">' + esc(a.pairingCode) + '</div><div class="pair-code-hint">Bu kodu WhatsApp\\'a gir</div>' : '';
            return '<div class="account-item ' + cls + '"><div class="account-row"><div class="dot ' + cls + '"></div><div class="account-name">' + esc(a.name || id) + '</div><button class="btn btn-ghost btn-sm" onclick="removeAccount(\\'' + esc(id) + '\\')">\\u2715</button></div><div class="account-status-text">' + esc(a.status) + '</div>' + code + '</div>';
        }).join('');
    }

    async function addAccount() {
        const name  = document.getElementById('acc-name').value.trim();
        const phone = document.getElementById('acc-phone').value.trim();
        if (!name)  { flash('acc-name');  return; }
        if (!phone) { flash('acc-phone'); return; }
        const r = await fetch('/api/accounts', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: name, phone })
        });
        const data = await r.json();
        if (data.error) { alert(data.error); return; }
        accounts[name] = { id: name, status: 'ba\\u015Flat\\u0131l\\u0131yor', name };
        renderAccounts();
        document.getElementById('acc-name').value  = '';
        document.getElementById('acc-phone').value = '';
        log('Hesap eklendi: ' + name, 'info');
    }

    async function removeAccount(id) {
        if (!confirm(id + ' hesab\\u0131n\\u0131 silmek istiyor musunuz?')) return;
        await fetch('/api/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
        delete accounts[id]; renderAccounts();
        log('Hesap silindi: ' + id, 'warn');
    }

    async function loadMessages() {
        const r = await fetch('/api/messages');
        messages = await r.json();
        renderMessages(); updateMsgSelect();
    }

    function renderMessages() {
        const el = document.getElementById('messages-list');
        if (!messages.length) {
            el.innerHTML = '<div class="empty"><div class="empty-icon">\\u2709\\uFE0F</div>Kay\\u0131tl\\u0131 mesaj yok<br><small style="color:var(--dim)">Yeni butonuyla ekleyin</small></div>';
            return;
        }
        el.innerHTML = messages.map(m => '<div class="msg-card"><div class="msg-card-head"><div class="msg-title">' + esc(m.title) + '</div><div class="msg-actions"><button class="btn btn-ghost btn-sm" onclick="editMsg(' + m.id + ')" title="D\\u00FCzenle">\\u270F\\uFE0F</button><button class="btn btn-ghost btn-sm" onclick="deleteMsg(' + m.id + ')" title="Sil">\\u{1F5D1}\\uFE0F</button></div></div><div class="msg-preview">' + esc(m.content) + '</div></div>').join('');
    }

    function updateMsgSelect() {
        const sel = document.getElementById('sel-msg');
        const cur = sel.value;
        sel.innerHTML = '<option value="">\\u2014 Mesaj se\\u00E7in \\u2014</option>' +
            messages.map(m => '<option value="' + m.id + '">' + esc(m.title) + '</option>').join('');
        if (cur) sel.value = cur;
        onMsgSelect();
    }

    function onMsgSelect() {
        const id = parseInt(document.getElementById('sel-msg').value);
        const m  = messages.find(x => x.id === id);
        const el = document.getElementById('msg-preview');
        el.textContent = m ? m.content : 'Mesaj se\\u00E7ilmedi';
        el.style.color  = m ? 'var(--text)' : 'var(--muted)';
    }

    function openMsgModal() {
        document.getElementById('modal-title').textContent   = 'Yeni Mesaj';
        document.getElementById('modal-mid').value           = '';
        document.getElementById('modal-mtitle').value        = '';
        document.getElementById('modal-mcontent').value      = '';
        document.getElementById('msg-modal').classList.add('active');
    }

    function editMsg(id) {
        const m = messages.find(x => x.id === id);
        if (!m) return;
        document.getElementById('modal-title').textContent   = 'Mesaj\\u0131 D\\u00FCzenle';
        document.getElementById('modal-mid').value           = m.id;
        document.getElementById('modal-mtitle').value        = m.title;
        document.getElementById('modal-mcontent').value      = m.content;
        document.getElementById('msg-modal').classList.add('active');
    }

    function closeMsgModal() { document.getElementById('msg-modal').classList.remove('active'); }

    async function saveMsg() {
        const id      = document.getElementById('modal-mid').value;
        const title   = document.getElementById('modal-mtitle').value.trim();
        const content = document.getElementById('modal-mcontent').value.trim();
        if (!title)   { flash('modal-mtitle');   return; }
        if (!content) { flash('modal-mcontent'); return; }
        const url    = id ? '/api/messages/' + id : '/api/messages';
        const method = id ? 'PUT' : 'POST';
        const r = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify({ title, content }) });
        const data = await r.json();
        if (data.error) { alert(data.error); return; }
        closeMsgModal(); await loadMessages();
        log(id ? 'Mesaj g\\u00FCncellendi: ' + title : 'Yeni mesaj kaydedildi: ' + title, 'info');
    }

    async function deleteMsg(id) {
        const m = messages.find(x => x.id === id);
        if (!confirm((m ? m.title : '') + ' mesaj\\u0131n\\u0131 silmek istiyor musunuz?')) return;
        await fetch('/api/messages/' + id, { method: 'DELETE' });
        await loadMessages();
        log('Mesaj silindi: ' + (m ? m.title : ''), 'warn');
    }

    async function startSend() {
        const msgId = parseInt(document.getElementById('sel-msg').value);
        const m = messages.find(x => x.id === msgId);
        if (!m) { alert('L\\u00FCtfen g\\u00F6nderilecek bir mesaj se\\u00E7in'); return; }

        const raw = document.getElementById('numbers').value;
        const numbers = raw.split('\\n').map(n => n.trim()).filter(n => n.length > 0);
        if (!numbers.length) { alert('Numara listesi bo\\u015F'); return; }

        const dMin   = parseInt(document.getElementById('d-min').value)   * 1000;
        const dMax   = parseInt(document.getElementById('d-max').value)   * 1000;
        const bCount = parseInt(document.getElementById('b-count').value);
        const bPause = parseInt(document.getElementById('b-pause').value) * 60000;

        const r = await fetch('/api/send', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ numbers, message: m.content, delayMin: dMin, delayMax: dMax, burstCount: bCount, burstPause: bPause })
        });
        const data = await r.json();
        if (data.error) alert(data.error);
    }

    async function stopSend() { await fetch('/api/stop', { method: 'POST' }); }

    function setSendBtns() {
        document.getElementById('btn-send').disabled = isSending;
        document.getElementById('btn-stop').disabled = !isSending;
    }

    function setStat(done, total, ok, err) {
        document.getElementById('s-prog').textContent = (done != null ? done : '?') + ' / ' + (total != null ? total : '?');
        if (ok  !== undefined) document.getElementById('s-ok').textContent  = ok;
        if (err !== undefined) document.getElementById('s-err').textContent = err;
        const pct = total > 0 ? (done / total * 100) : 0;
        document.getElementById('prog-fill').style.width = pct + '%';
    }

    function log(text, cls) {
        const el  = document.getElementById('log');
        const t   = new Date().toLocaleTimeString('tr-TR');
        const div = document.createElement('div');
        div.className = 'le ' + (cls || '');
        div.textContent = '[' + t + '] ' + text;
        el.appendChild(div);
        el.scrollTop = el.scrollHeight;
    }

    function clearLog() {
        document.getElementById('log').innerHTML = '';
        setStat(0, 0, 0, 0);
    }

    function esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function flash(id) {
        const el = document.getElementById(id);
        el.style.borderColor = 'var(--err)';
        el.style.boxShadow   = '0 0 10px rgba(239,68,68,0.4)';
        el.focus();
        setTimeout(function() { el.style.borderColor = ''; el.style.boxShadow = ''; }, 1400);
    }

    document.getElementById('msg-modal').addEventListener('click', function(e) {
        if (e.target === document.getElementById('msg-modal')) closeMsgModal();
    });
    document.getElementById('acc-phone').addEventListener('keypress', function(e) { if (e.key === 'Enter') addAccount(); });
    document.getElementById('acc-name').addEventListener('keypress', function(e) { if (e.key === 'Enter') document.getElementById('acc-phone').focus(); });

    loadAccounts();
    loadMessages();
    log('Sistem haz\\u0131r. Hesap ekleyip mesaj kaydedin.', 'info');
<\/script>
</body>
</html>`;

fs.writeFileSync(path.join(__dirname, 'public', 'index.html'), html, 'utf8');
console.log('index.html yazildi:', fs.statSync(path.join(__dirname, 'public', 'index.html')).size, 'bytes');
