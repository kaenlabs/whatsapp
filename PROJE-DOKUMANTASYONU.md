# 📱 WhatsApp Toplu Mesaj Göndericisi — Proje Dokümantasyonu

> **Versiyon:** 2.0.0  
> **Platform:** Windows (Portable EXE)  
> **Teknolojiler:** Node.js, Express, Socket.IO, whatsapp-web.js, Electron, Puppeteer

---

## 📁 Proje Yapısı

```
whatsapp-sender/
├── server.js              # Ana backend sunucu (Express + Socket.IO + WhatsApp)
├── electron.js            # Electron masaüstü uygulaması (splash screen + pencere)
├── public/
│   └── index.html         # Tek sayfalık frontend (HTML + CSS + JS)
├── package.json           # Bağımlılıklar ve build ayarları
├── baslat.bat             # Windows başlatıcı script (web / electron modu)
├── write-html.js          # HTML dosyası üretici yardımcı script
├── messages.json          # Kayıtlı mesaj şablonları
├── notes.json             # Kullanıcı notları
├── proxy.json             # Proxy ayarları
├── dist/                  # Build çıktısı
│   └── WhatsApp-Sender.exe   # Portable EXE (~75MB)
└── whatsapp-sender-data/  # Çalışma zamanı verileri (EXE yanında oluşur)
    ├── messages.json
    ├── sent-log.json
    ├── notes.json
    ├── proxy.json
    ├── replies.json
    ├── .wwebjs_auth/      # WhatsApp oturum verileri
    ├── .wwebjs_cache/     # Puppeteer/Chromium önbellek
    └── tor/               # Tor VPN dosyaları
        ├── tor/           # Tor binary'leri (tor.exe, geoip, geoip6)
        ├── data/          # Tor çalışma dizini (lock, cookie)
        └── torrc          # Tor yapılandırma dosyası (otomatik oluşturulur)
```

---

## ⚙️ Bağımlılıklar

### Üretim (dependencies)
| Paket | Versiyon | Açıklama |
|-------|----------|----------|
| `express` | ^4.18.2 | HTTP sunucu framework |
| `socket.io` | ^4.7.4 | Gerçek zamanlı WebSocket iletişimi |
| `whatsapp-web.js` | github:pedroslopez | WhatsApp Web otomasyon kütüphanesi |
| `qrcode` | ^1.5.3 | QR kod üretimi (hesap eşleme) |

### Geliştirme (devDependencies)
| Paket | Versiyon | Açıklama |
|-------|----------|----------|
| `electron` | ^28.1.0 | Masaüstü uygulama çatısı |
| `electron-builder` | ^24.9.1 | EXE paketleme aracı |

### Dahili Node.js Modülleri
`http`, `https`, `path`, `fs`, `child_process` (exec, spawn, execSync), `net`, `zlib`

---

## 🖥️ Çalıştırma Modları

### 1. Web Modu
```bash
node server.js
# veya
npm start
```
Tarayıcıda `http://localhost:3000` adresinden erişilir.

### 2. Electron Masaüstü Modu
```bash
npx electron .
# veya
npm run desktop
```
Splash screen → bağımlılık kontrolü → ana pencere açılır.

### 3. Portable EXE Build
```bash
npx electron-builder --win portable --config.win.signAndEditExecutable=false
```
`dist/WhatsApp-Sender.exe` oluşturulur. Herhangi bir klasöre kopyalanarak çalıştırılabilir.

### 4. baslat.bat
Windows'ta çift tıkla açılır, menüden web veya electron modu seçilir. Otomatik npm install yapar.

---

## 📦 Veri Depolama (DATA_DIR)

EXE olarak çalışırken veriler ASAR arşivi dışında tutulur. `PORTABLE_EXECUTABLE_DIR` ortam değişkeni kullanılarak EXE'nin yanında `whatsapp-sender-data/` klasörü oluşturulur.

```javascript
function getDataDir() {
    // Portable EXE → EXE'nin yanında
    // Normal çalıştırma → proje kök dizini
}
```

### Dosya Formatları

**messages.json**
```json
[
  { "id": 1772875344773, "title": "Kampanya 1", "content": "Merhaba, size özel..." }
]
```

**sent-log.json**
```json
[
  { "number": "905551234567", "account": "hesap1", "status": "başarılı", "date": "2026-03-08T..." },
  { "number": "905559876543", "account": "hesap1", "status": "hata", "error": "Number not on WhatsApp", "date": "..." }
]
```

**replies.json**
```json
[
  { "id": 1, "number": "905551234567", "name": "Ahmet", "message": "Merhaba", "account": "hesap1", "date": "..." }
]
```

**notes.json**
```json
[
  { "id": 1709900000000, "content": "Bu not...", "date": "2026-03-08T15:00:00.000Z" }
]
```

**proxy.json**
```json
{
  "enabled": false,
  "type": "socks5",
  "host": "127.0.0.1",
  "port": "9050",
  "username": "",
  "password": ""
}
```

---

## 🌐 REST API Endpointleri

### Hesap Yönetimi

| Metod | Yol | Açıklama |
|-------|-----|----------|
| `GET` | `/api/accounts` | Tüm hesapları listele |
| `POST` | `/api/accounts` | Yeni hesap ekle `{ id: "isim" }` |
| `DELETE` | `/api/accounts/:id` | Hesabı sil ve oturumu temizle |

**Hesap Durumları:**
- `başlatılıyor` → İlk bağlantı
- `qr-bekleniyor` → QR kod taranmayı bekliyor
- `doğrulandı` → Kimlik doğrulandı
- `bağlı` → Aktif, mesaj gönderebilir
- `auth-hatası` → Kimlik doğrulama başarısız
- `bağlantı-kesildi` → Bağlantı koptu
- `spam-engeli` → WhatsApp spam tespit etti, hesap otomatik çıkarıldı
- `hata` → Genel hata

### Mesaj CRUD

| Metod | Yol | Açıklama |
|-------|-----|----------|
| `GET` | `/api/messages` | Tüm kayıtlı mesajları getir |
| `POST` | `/api/messages` | Yeni mesaj oluştur `{ title, content }` |
| `PUT` | `/api/messages/:id` | Mesaj güncelle `{ title, content }` |
| `DELETE` | `/api/messages/:id` | Mesaj sil |

### Gönderim

| Metod | Yol | Açıklama |
|-------|-----|----------|
| `POST` | `/api/send` | Toplu gönderim başlat |
| `POST` | `/api/stop` | Devam eden gönderimi durdur |
| `GET` | `/api/sent-log` | Gönderim geçmişi (salt okunur) |

**Gönderim İsteği:**
```json
{
  "numbers": ["905551234567", "905559876543"],
  "messages": ["Mesaj 1 içeriği", "Mesaj 2 içeriği"],
  "messageMode": "sequential",
  "delayMin": 15,
  "delayMax": 45,
  "burstCount": 10,
  "burstPause": 5
}
```

### Dönüşler (Replies)

| Metod | Yol | Açıklama |
|-------|-----|----------|
| `GET` | `/api/replies` | Gelen dönüş mesajlarını listele |

### Notlar

| Metod | Yol | Açıklama |
|-------|-----|----------|
| `GET` | `/api/notes` | Tüm notları getir |
| `POST` | `/api/notes` | Yeni not ekle `{ content }` |
| `DELETE` | `/api/notes/:id` | Not sil |

### Proxy

| Metod | Yol | Açıklama |
|-------|-----|----------|
| `GET` | `/api/proxy` | Proxy ayarlarını getir |
| `POST` | `/api/proxy` | Proxy ayarlarını kaydet |
| `POST` | `/api/proxy/test` | Proxy testi yap (IP karşılaştırma) |
| `GET` | `/api/myip` | Gerçek IP adresini öğren |

### Tor VPN

| Metod | Yol | Açıklama |
|-------|-----|----------|
| `GET` | `/api/tor/status` | Tor durumu `{ installed, running, port }` |
| `POST` | `/api/tor/start` | Tor'u başlat, proxy'i otomatik ayarla |
| `POST` | `/api/tor/stop` | Tor'u kapat, proxy'i devre dışı bırak |
| `POST` | `/api/tor/newip` | Yeni Tor IP adresi al (NEWNYM) |
| `POST` | `/api/tor/download` | Tor Expert Bundle indir `{ force: bool }` |

### WARP VPN (Legacy)

| Metod | Yol | Açıklama |
|-------|-----|----------|
| `GET` | `/api/warp/status` | Cloudflare WARP durumu |
| `POST` | `/api/warp/connect` | WARP bağlan |
| `POST` | `/api/warp/disconnect` | WARP bağlantısını kes |

---

## 🔌 Socket.IO Olayları

### Sunucu → İstemci

| Olay | Veri | Açıklama |
|------|------|----------|
| `account-update` | `{ id, status, name }` | Hesap durumu değişti |
| `account-removed` | `{ id }` | Hesap silindi |
| `qr-code` | `{ id, qr }` | QR kod hazır (base64 data URL) |
| `qr-done` | `{ id }` | QR tarandı, hesap doğrulandı |
| `spam-detected` | `{ id, reason }` | Spam engeli tespit edildi |
| `send-started` | `{ total }` | Gönderim başladı |
| `send-progress` | `{ number, status, accountName, index, total, successCount, errorCount }` | Tek mesaj gönderildi/hata |
| `send-log` | `{ text, type }` | Log mesajı |
| `send-pause` | `{ seconds, index, total }` | Burst molası |
| `send-complete` | `{ total, successCount, errorCount, skippedCount }` | Gönderim tamamlandı |
| `send-stopped` | `{ index, total }` | Gönderim durduruldu |
| `sent-log-update` | `[array]` | Gönderim geçmişi güncellendi |
| `reply-received` | `{ id, number, name, message, account, date }` | Gönderilen numaradan dönüş geldi |
| `tor-status` | – | Tor durumu değişti |
| `tor-download-progress` | `{ message }` | İndirme ilerleme mesajı |
| `tor-download-complete` | `{ success, message, error? }` | İndirme tamamlandı |

---

## 🚀 Gönderim Motoru (sendMessages)

### Akış

```
Başlat → Hesap kontrolü → Her numara için:
  │
  ├─ Hesap seç (rotasyon/yük dengeleme)
  ├─ getNumberId() ile numara doğrula
  ├─ Rastgele Türkçe isimle rehbere kaydet
  ├─ Sohbeti aç → sendSeen() → sendStateTyping()
  ├─ Mesaj seç (sıralı veya rastgele mod)
  ├─ sendMessage() ile gönder
  ├─ sentLog'a kaydet + sentNumbers Set'e ekle
  ├─ send-progress emit et
  │
  ├─ Rastgele bekleme (delayMin ~ delayMax saniye)
  └─ Her burstCount mesajda → burstPause dakika mola
```

### Mesaj Seçimi
- **Sıralı mod (sequential):** Mesajlar sırayla döner (1, 2, 3, 1, 2, 3...)
- **Rastgele mod (random):** Her numara için rastgele mesaj seçilir

### Güvenlik Önlemleri
| Parametre | Minimum | Varsayılan |
|-----------|---------|------------|
| Min Bekleme | 1 saniye | 15 saniye |
| Max Bekleme | 2 saniye | 45 saniye |
| Burst Sayısı | 1 | 10 mesaj |
| Burst Molası | 1 dakika | 5 dakika |

### Otomatik Rehber Kaydı
Her gönderimde numara rastgele Türkçe isimle kaydedilir:
- 64 Türkçe erkek/kadın isim (Ahmet, Mehmet, Fatma, Ayşe...)
- 40 Türkçe soyisim (Yılmaz, Kaya, Demir, Çelik...)
- Format: `randomName().full` → "Mehmet Yılmaz"

### Hesap Dengeleme (pickAccount)
- Bağlı hesaplar arasında rotasyonla seçim
- Hesap gönderim sırasında düşerse otomatik atlama
- Tüm hesaplar düşerse gönderim durdurulur

---

## 🔒 Tor VPN Sistemi

### Mimari
```
Uygulama → spawn(tor.exe) → SOCKS5 Proxy (127.0.0.1:9050)
                           → ControlPort (127.0.0.1:9051)
```

### findTorExe() Arama Sırası
1. `{DATA_DIR}/tor/tor/tor.exe` (İndirilen bundle)
2. `where tor.exe` (Sistem PATH)
3. `%LOCALAPPDATA%\Tor Browser\Browser\TorBrowser\Tor\tor.exe`
4. `%PROGRAMFILES%\Tor\tor.exe`

### startTor() — Başlatma
1. Eski `lock` dosyasını temizle (crash kalıntısı)
2. `torrc` yapılandırma dosyasını oluştur
3. `spawn(tor.exe, ['-f', torrcPath])` ile başlat
4. stdout'ta `"100%"` bekle (bootstrap tamamlandı)
5. 30 saniye timeout
6. Detaylı hata mesajları: port çakışması, izin hatası, dosya eksik

### torNewIdentity() — IP Değiştirme
1. `{TOR_DIR}/data/control_auth_cookie` dosyasını oku
2. TCP socket ile 127.0.0.1:9051'e bağlan
3. `AUTHENTICATE {cookie_hex}` gönder
4. `SIGNAL NEWNYM` gönder → Yeni devre, yeni IP

### downloadTor() — Otomatik İndirme
1. `https://dist.torproject.org/torbrowser/` sayfasından versiyon listesi çek
2. En yeni versiyondan başla, `tor-expert-bundle-windows-x86_64-{ver}.tar.gz` indir
3. Node.js `https` modülü ile indir (curl bağımlılığı yok)
4. İndirme sırasında yüzde göstergesi emit et
5. `tar` komutu ile aç, başarısızsa Node.js ile tar parse et
6. `force: true` parametresiyle eski dosyaları silip yeniden indir

---

## 📩 Dönüş Takip Sistemi (Replies)

### Çalışma Prensibi
1. Başarılı gönderimde numara `sentNumbers` Set'ine eklenir
2. `client.on('message')` dinleyicisi her mesajı yakalar
3. Gelen mesajın numarası `sentNumbers`'da varsa → dönüş olarak kaydedilir
4. `reply-received` socket olayı ile frontend'e anlık bildirim
5. `replies.json` dosyasına kalıcı kayıt

### Windows Masaüstü Bildirimi
```javascript
new Notification('Dönüş Var!', {
    body: 'Ahmet (905551234567) mesaj gönderdi:\nMerhaba, ilgileniyorum'
});
```
- Uygulama başlatıldığında `Notification.requestPermission()` ile izin istenir
- Sadece izin verilmişse bildirim gösterilir

### Frontend Gösterimi
- **Dönüşler sekmesi:** Mor kenarlıklı kartlar halinde listelenir
- **Kırmızı badge:** Sekme başlığında toplam dönüş sayısı gösterilir
- Her kartta: numara, isim, mesaj metni, tarih, hesap adı

---

## 🖼️ Frontend Arayüz (index.html)

### Sayfa Düzeni
```
┌──────────────────────────────────────────────────────┐
│  💬 WhatsApp Mesaj Göndericisi                       │  HEADER
├─────────────┬──────────────────┬─────────────────────┤
│             │                  │                     │
│  ⚡ Hesaplar │  📝 Kayıtlı     │  🚀 Gönderim        │
│             │     Mesajlar     │                     │
│  [Hesap 1]  │  [Mesaj Kartı]  │  ☑ Mesaj seçimi     │
│  [Hesap 2]  │  [Mesaj Kartı]  │  📋Sıralı 🎲Rastgele│
│             │                 │  Numara listesi     │
│  + Yeni     │  + Yeni         │  Bekleme ayarları   │
│    Hesap    │                 │  [▶ Başlat] [⏹ Dur] │
├─────────────┴──────────────────┴─────────────────────┤
│  📋LOG │ 📨GÖNDERİLENLER │ 📩DÖNÜŞLER │ 📝NOTLAR │ 🔐PROXY │
│                                                      │
│  [İlerleme çubuğu] Başarılı: 42  Hatalı: 3          │
│  [15:30:01] ✓ 905551234567  via Hesap1               │
│  [15:30:16] ✓ 905559876543  via Hesap2               │
└──────────────────────────────────────────────────────┘
```

### Sekmeler

| Sekme | İçerik |
|-------|--------|
| **📋 Log** | Gerçek zamanlı gönderim logları, ilerleme çubuğu, istatistikler |
| **📨 Gönderilenler** | Kalıcı gönderim geçmişi (silinemez) — numara, hesap, durum, tarih |
| **📩 Dönüşler** | Gelen cevaplar — numara, isim, mesaj, tarih, hesap |
| **📝 Notlar** | Hızlı not ekleme/silme alanı |
| **🔐 Proxy** | Tor VPN kontrolü + Manuel proxy ayarları + Proxy testi |

### Tema
- **Koyu mor/siyah tema** (cyberpunk tarzı)
- Ana renk: `#7c3aed` (mor)
- Arkaplan: `#080810` (koyu siyah)
- Başarılı: `#10b981` (yeşil)
- Hata: `#ef4444` (kırmızı)
- Uyarı: `#f59e0b` (sarı)
- Glow efektleri, gradient butonlar, animasyonlar

### Proxy Sekmesi Detayı
```
┌─────────────────────────────────────┐
│  🔐 Tor VPN          [KAPALI]      │
│  [🚀 Tor Aç] [🔄 Yeni IP] [⏹ Kapat]│
│  📥 Tor İndir (dosya yoksa görünür) │
├─────────────────────────────────────┤
│  ⚠ Proxy kapalı — Kendi IP'niz     │
│  Proxy Tipi: [HTTP ▼]              │
│  Host: [________] Port: [____]     │
│  Kullanıcı: [______] Şifre: [____] │
│  [🔍 Test Et] [💾 Kaydet ve Aç]     │
│  ✅ Proxy çalışıyor! IP: x.x.x.x  │
└─────────────────────────────────────┘
```

---

## 🖥️ Electron Uygulaması (electron.js)

### Splash Screen (Açılış Ekranı)
Uygulama başladığında bağımlılık kontrolü yapılır:

| Kontrol | Açıklama |
|---------|----------|
| **Node Modülleri** | express, socket.io, whatsapp-web.js var mı? |
| **Chromium/Chrome** | Puppeteer cache veya sistem Chrome var mı? |
| **cURL** | Proxy testi için gerekli (opsiyonel) |

- Hepsi varsa → ana pencere açılır
- Eksik varsa → "Bağımlılıkları Yükle" butonu çıkar
- Yükleme: `npm install --production` çalıştırılır

### Ana Pencere
- **Boyut:** 1280×800, minimum 1000×650
- **İçerik:** `http://localhost:3000` (server.js)
- **Arkaplan:** `#080810`
- **Kapatma:** Onay dialogu gösterilir

### Sistem Chrome Tespiti
Puppeteer kendi Chromium'unu bulamazsa sistem Chrome'u aranır:
- `Program Files\Google\Chrome\Application\chrome.exe`
- `Program Files (x86)\Google\Chrome\Application\chrome.exe`
- `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`

Bulunursa `PUPPETEER_EXECUTABLE_PATH` ortam değişkenine ayarlanır.

---

## 🛡️ Hata Yönetimi ve Kurtarma

### Genel
- `process.on('uncaughtException')` → Loglayıp devam et
- `process.on('unhandledRejection')` → Loglayıp devam et
- Uygulama kritik olmayan hatalarda kapanmaz

### Gönderim Sırasında
- Tek mesaj hatası → loglanır, sonrakine geçilir
- Hesap düşmesi → o hesap atlanır, diğer hesaplardan devam
- Tüm hesaplar düşerse → gönderim durdurulur

### Tor Hataları
| Durum | Mesaj | Çözüm |
|-------|-------|-------|
| Port meşgul | "Port 9050/9051 kullanılıyor" | Başka Tor kapansın |
| İzin hatası | "Dosya izin hatası" | Farklı klasöre taşı |
| Dosya eksik | "Tor dosyaları eksik" | Yeniden İndir butonu |
| Timeout | "30s aşımı" | İnternet kontrol |
| Crash | "Tor kapandı (kod: X)" | Yeniden İndir butonu |

### Spam Tespiti
WhatsApp spam engeli algılandığında:
1. Hesap durumu `'spam-engeli'` olur
2. Log'a kırmızı uyarı yazılır
3. Hesap otomatik devre dışı bırakılır
4. Diğer hesaplardan gönderime devam edilir

---

## 🔧 Yapılandırma Parametreleri

### Gönderim Ayarları
| Parametre | Minimum | Varsayılan | Maksimum | Açıklama |
|-----------|---------|------------|----------|----------|
| Min Bekleme | 1 sn | 15 sn | ∞ | Mesajlar arası minimum bekleme |
| Max Bekleme | 2 sn | 45 sn | ∞ | Mesajlar arası maksimum bekleme |
| Burst Sayısı | 1 | 10 | ∞ | Kaç mesajda bir mola |
| Burst Molası | 1 dk | 5 dk | ∞ | Mola süresi |

### Proxy Tipleri
| Tip | Port | Açıklama |
|-----|------|----------|
| `http` | – | HTTP proxy |
| `https` | – | HTTPS proxy |
| `socks5` | – | SOCKS5 proxy (Tor için varsayılan) |

### Tor Sabit Portlar
| Port | Kullanım |
|------|----------|
| `9050` | SOCKS5 proxy |
| `9051` | Control port (IP değiştirme) |

---

## 📦 Build & Dağıtım

### Portable EXE Oluşturma
```bash
npx electron-builder --win portable --config.win.signAndEditExecutable=false
```

### Build Ayarları (package.json)
```json
{
  "build": {
    "appId": "com.whatsapp.sender",
    "productName": "WhatsApp Sender",
    "files": ["**/*", "!dist/**", "!.wwebjs_auth/**", "!.wwebjs_cache/**"],
    "win": { "target": ["portable"] },
    "portable": { "artifactName": "WhatsApp-Sender.exe" }
  }
}
```

### Çıktı
- `dist/WhatsApp-Sender.exe` — Tek dosya, kurulum gerektirmez
- Çalıştırıldığında yanında `whatsapp-sender-data/` klasörü oluşturur
- Tüm veriler bu klasörde saklanır (taşınabilir)

---

## 🔄 Tam Özellik Listesi

1. **Çoklu WhatsApp Hesabı** — Birden fazla hesap ekle, QR ile eşle
2. **Kayıtlı Mesaj Şablonları** — CRUD işlemleri, çoklu mesaj seçimi
3. **Sıralı / Rastgele Mesaj Modu** — Mesajları döngüsel veya rastgele gönder
4. **Toplu Gönderim** — Numara listesine tek tuşla gönder
5. **Akıllı Bekleme** — Min/max arası rastgele bekleme + burst molası
6. **Otomatik Rehber Kaydı** — Rastgele Türkçe isimlerle kişi kaydetme
7. **Hesap Dengeleme** — Hesaplar arası rotasyonlu gönderim
8. **Spam Koruması** — WhatsApp ban tespiti, otomatik hesap devre dışı
9. **Gönderim Geçmişi** — Kalıcı log, silinemez kayıtlar
10. **Dönüş Takibi** — Gelen cevapları algıla, bildirim gönder
11. **Windows Bildirimi** — Masaüstü notification (sağ alt köşe)
12. **Tor VPN** — Dahili Tor, tek tuşla aç/kapat/IP değiştir
13. **Tor Otomatik İndirme** — Expert Bundle indir, yüzde göstergesi
14. **Manuel Proxy Desteği** — HTTP/HTTPS/SOCKS5, test ve doğrulama
15. **WARP VPN** — Cloudflare WARP desteği (legacy)
16. **Not Defteri** — Hızlı not ekleme/silme
17. **Electron Masaüstü** — Splash screen, bağımlılık kontrolü, portable EXE
18. **ASAR Veri Koruması** — EXE dışına veri yazma, taşınabilir veriler
19. **Gerçek Zamanlı UI** — Socket.IO ile anlık log, istatistik, durum
20. **Koyu Mor Tema** — Cyberpunk tarzı arayüz, glow efektleri

---

> **Son Güncelleme:** Mart 2026
