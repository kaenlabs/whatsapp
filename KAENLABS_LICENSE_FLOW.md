# KaenLabs Desktop License Flow

Bu doküman, **WhatsApp Sender desktop uygulamasında** kullanılan lisans mantığını başka bir geliştiriciye / yapay zekâya aktarmak için hazırlanmıştır. Amaç, `kaenlabs.net` tarafında lisans anahtarı üretme / yönetme ekranı ve doğrulama mantığını bu akışa uygun hale getirmektir.

---

## 1. Amaç

Masaüstü uygulama için şu ihtiyaçlar çözülüyor:

1. Uygulama ilk açılışta lisans anahtarı sorsun.
2. Lisans anahtarı online olarak KaenLabs API üzerinden doğrulansın.
3. Lisans bilgisi güncellemede silinmesin.
4. Lisans bir **kurulum kimliğine** bağlansın.
5. Aynı lisans anahtarı kontrolsüz şekilde farklı kurulumlarda kullanılamasın.

---

## 2. Desktop tarafındaki çalışma mantığı

Electron uygulamasında lisans bilgisi aşağıdaki dosyada saklanır:

- `DATA_DIR/license.json`

`DATA_DIR` uygulamanın kalıcı veri klasörüdür.
Bu klasör uygulama güncellense bile korunur.

### license.json örnek yapısı

```json
{
  "installationId": "a1b2c3d4e5f67890abcd1234ef567890",
  "licenseKey": "XXXX-XXXX-XXXX-XXXX",
  "activatedAt": "2026-03-25T10:20:30.000Z",
  "lastVerifiedAt": "2026-03-25T10:21:10.000Z",
  "lastSuccessAt": "2026-03-25T10:21:10.000Z",
  "lastError": "",
  "status": "active"
}
```

### Alanların anlamı

- `installationId`: Bu kurulum için üretilen benzersiz kimlik
- `licenseKey`: Kullanıcının girdiği lisans anahtarı
- `activatedAt`: İlk başarılı aktivasyon zamanı
- `lastVerifiedAt`: En son doğrulama denemesi
- `lastSuccessAt`: En son başarılı doğrulama zamanı
- `lastError`: Son hata mesajı
- `status`: `missing`, `pending`, `invalid`, `offline`, `active`

---

## 3. Kurulum kimliği mantığı

Desktop uygulamada lisans doğrudan domain’e değil, şu yapıya bağlanır:

```text
domain = desktop:<installation_id>
```

Örnek:

```text
desktop:a1b2c3d4e5f67890abcd1234ef567890
```

Bu alan mevcut KaenLabs lisans altyapısındaki `domain` mantığını bozmadan masaüstüne uyarlamak için kullanılır.

### Neden bu yöntem?

Çünkü web tarafındaki sistem zaten `domain` alanına bağlanıyor.
Desktop uygulamada gerçek domain olmadığı için bunun yerine şu mantık kullanılır:

- web: `example.com`
- desktop: `desktop:<installation_id>`

Bu sayede backend tarafında minimum değişiklik gerekir.

---

## 4. Lisans doğrulama akışı

Uygulama açıldığında:

1. `license.json` okunur.
2. Lisans anahtarı yoksa kullanıcıya lisans ekranı gösterilir.
3. Lisans anahtarı varsa KaenLabs API’ye `verify` isteği atılır.
4. Doğrulama başarılıysa uygulama açılır.
5. Doğrulama başarısızsa uygulama açılmaz.
6. Sunucu geçici olarak erişilemezse kısa bir **grace period** uygulanabilir.

### Aktivasyon akışı

Kullanıcı lisans anahtarını ilk kez girdiğinde:

- API’ye `action=activate` ile istek atılır.
- Sunucu bu lisansı `desktop:<installation_id>` alanına bağlar.
- Başarılıysa `license.json` güncellenir.

### Sonraki açılışlar

- API’ye `action=verify` ile istek atılır.
- Aynı lisans + aynı installation bağlamı doğrulanır.

---

## 5. KaenLabs API’ye gönderilecek alanlar

Desktop uygulama KaenLabs doğrulama endpoint’ine şu alanları gönderir:

```json
{
  "license_key": "XXXX-XXXX-XXXX-XXXX",
  "domain": "desktop:a1b2c3d4e5f67890abcd1234ef567890",
  "product": "whatsapp-sender",
  "action": "activate",
  "server_ip": "",
  "timestamp": 1719999999,
  "signature": "hmac_sha256_signature"
}
```

### Alan açıklamaları

- `license_key`: Kullanıcının lisans anahtarı
- `domain`: `desktop:<installation_id>`
- `product`: Ürün slug’ı, şu an `whatsapp-sender`
- `action`: `activate` veya `verify`
- `server_ip`: Desktop için zorunlu değil, boş geçilebilir
- `timestamp`: Unix timestamp
- `signature`: HMAC imza

---

## 6. İmza mantığı

İstekler HMAC ile imzalanır.
Kullanılan secret:

```text
K4eN_L4b5_2026_pr0d_s3cur1ty
```

### İstek imzası üretimi

İmza, `signature` alanı hariç payload’ın JSON hali üzerinden oluşturulur.

Pseudo:

```php
$payload = [
  'license_key' => 'XXXX-XXXX-XXXX-XXXX',
  'domain' => 'desktop:a1b2c3d4...',
  'product' => 'whatsapp-sender',
  'action' => 'activate',
  'server_ip' => '',
  'timestamp' => 1719999999
];

$signature = hash_hmac('sha256', json_encode($payload), LICENSE_SECRET);
```

Aynı mantık response için de geçerli olmalı.

---

## 7. API response beklentisi

Desktop uygulama response içinde bir `signature` bekler.
`signature` hariç response body tekrar HMAC ile doğrulanır.

### Örnek başarılı response

```json
{
  "valid": true,
  "status": "active",
  "message": "Lisans doğrulandı",
  "license_key": "XXXX-XXXX-XXXX-XXXX",
  "domain": "desktop:a1b2c3d4e5f67890abcd1234ef567890",
  "product": "whatsapp-sender",
  "expires_at": null,
  "signature": "response_hmac_signature"
}
```

### Örnek başarısız response

```json
{
  "valid": false,
  "status": "invalid",
  "message": "Lisans geçersiz veya başka kurulumda aktif",
  "signature": "response_hmac_signature"
}
```

### Desktop tarafının kabul ettiği başarı durumları

Aşağıdaki alanlardan biri başarı olarak yorumlanabilir:

- `valid === true`
- `success === true`
- `status === 'valid'`
- `status === 'active'`

---

## 8. Backend tarafında beklenen lisans kuralları

KaenLabs tarafındaki lisans sistemi en az şu kuralları desteklemeli:

### Aktivasyon sırasında

- Lisans anahtarı geçerli mi?
- Ürün eşleşiyor mu? (`whatsapp-sender`)
- Lisans süresi dolmuş mu?
- Lisans daha önce bir `domain` / kurulum ile bağlanmış mı?

### Önerilen davranış

#### Senaryo A — lisans ilk kez aktive ediliyor
- `domain` boşsa veya kayıt yoksa:
  - gelen `desktop:<installation_id>` değeri lisansa yaz
  - aktivasyona izin ver

#### Senaryo B — aynı kurulum tekrar doğruluyor
- lisans zaten aynı `desktop:<installation_id>` ile bağlıysa:
  - doğrulamaya izin ver

#### Senaryo C — farklı kurulumdan aktivasyon geliyor
- lisans başka bir `desktop:<installation_id>` ile bağlıysa:
  - reddet
  - response message: `Bu lisans başka bir kurulumda aktif`

#### Senaryo D — admin panelden reset yapılmışsa
- admin mevcut domain binding’i temizler
- lisans yeniden başka cihazda aktive edilebilir

---

## 9. KaenLabs admin panelinde yapılması gerekenler

Başka yapay zekâ / geliştirici için net görev listesi:

### 9.1 Lisans oluşturma ekranı
Panelde şunlar olmalı:

- yeni lisans anahtarı üret
- ürün seç (`whatsapp-sender`)
- maksimum aktivasyon sayısı belirle (opsiyonel)
- lisans süresi belirle (opsiyonel)
- lisans durumu: aktif/pasif
- not alanı

### 9.2 Lisans detay ekranı
Şunlar görüntülenmeli:

- lisans anahtarı
- ürün
- oluşturulma tarihi
- son doğrulama tarihi
- bağlı `domain`
- domain değeri örnek olarak `desktop:xxxx...`
- expire tarihi
- durum
- manuel reset / unlink butonu

### 9.3 Desktop uyumlu domain desteği
Panelde `domain` alanı web domain gibi görünse de şu format kabul edilmeli:

```text
desktop:<installation_id>
```

### 9.4 Doğrulama endpoint’i
Mevcut `verify.php` mantığı desktop kullanımını da desteklemeli:

- `action=activate`
- `action=verify`
- request signature check
- response signature üretimi

---

## 10. Önerilen veritabanı alanları

Eğer mevcut tabloda yoksa aşağıdaki alanlar faydalı olur:

- `license_key`
- `product`
- `bound_domain`
- `status`
- `expires_at`
- `created_at`
- `updated_at`
- `last_verified_at`
- `notes`

Opsiyonel:

- `activation_count`
- `max_activation_count`
- `customer_name`
- `customer_email`

---

## 11. Örnek backend karar mantığı

Pseudo:

```php
if (!verify_request_signature($request, LICENSE_SECRET)) {
    return signed_response([
        'valid' => false,
        'status' => 'invalid_signature',
        'message' => 'Geçersiz imza'
    ]);
}

$license = find_license($request['license_key'], $request['product']);

if (!$license) {
    return signed_response([
        'valid' => false,
        'status' => 'not_found',
        'message' => 'Lisans bulunamadı'
    ]);
}

if ($license['status'] !== 'active') {
    return signed_response([
        'valid' => false,
        'status' => 'disabled',
        'message' => 'Lisans pasif'
    ]);
}

if (!empty($license['expires_at']) && strtotime($license['expires_at']) < time()) {
    return signed_response([
        'valid' => false,
        'status' => 'expired',
        'message' => 'Lisans süresi dolmuş'
    ]);
}

$incomingDomain = $request['domain'];
$storedDomain = $license['bound_domain'];

if ($request['action'] === 'activate') {
    if (empty($storedDomain)) {
        bind_domain($license['id'], $incomingDomain);
    } elseif ($storedDomain !== $incomingDomain) {
        return signed_response([
            'valid' => false,
            'status' => 'already_bound',
            'message' => 'Bu lisans başka bir kurulumda aktif'
        ]);
    }
}

if ($request['action'] === 'verify') {
    if (!empty($storedDomain) && $storedDomain !== $incomingDomain) {
        return signed_response([
            'valid' => false,
            'status' => 'domain_mismatch',
            'message' => 'Kurulum eşleşmiyor'
        ]);
    }
}

update_last_verified_at($license['id']);

return signed_response([
    'valid' => true,
    'status' => 'active',
    'message' => 'Lisans doğrulandı',
    'license_key' => $license['license_key'],
    'domain' => $incomingDomain,
    'product' => $license['product'],
    'expires_at' => $license['expires_at']
]);
```

---

## 12. Güvenlik notu

Önemli gerçek:

Desktop uygulamada hiçbir secret %100 gizli tutulamaz.

Bu yüzden hedef:

- tamamen kırılamaz bir client-side lisans sistemi yapmak değil,
- **sunucu otoriteli**, **online doğrulamalı**, **kuruluma bağlı**, **güncellemede kalıcı** bir sistem kurmaktır.

Yani asıl otorite KaenLabs backend olmalıdır.

---

## 13. Başka yapay zekâya verilecek kısa görev özeti

Bu kısmı doğrudan başka AI’a verebilirsiniz:

> KaenLabs tarafında mevcut lisans altyapısını desktop uygulama ile uyumlu hale getir. `domain` alanı artık web domain yanında `desktop:<installation_id>` formatını da desteklemeli. `verify.php` endpoint’i `action=activate` ve `action=verify` desteklemeli. Request ve response HMAC SHA-256 ile `LICENSE_SECRET = K4eN_L4b5_2026_pr0d_s3cur1ty` kullanılarak imzalanmalı. Admin panelde lisans oluşturma, lisans görüntüleme, bağlı kurulum (`bound_domain`) görme ve resetleme alanı olmalı. Ürün slug’ı `whatsapp-sender` olacak. Aynı lisans başka kurulumda aktifse aktivasyon reddedilmeli. Aynı kurulumdan verify gelirse kabul edilmeli.

---

## 14. Desktop uygulamanın şu an beklediği minimum sözleşme

### Request

```json
{
  "license_key": "KEY",
  "domain": "desktop:INSTALLATION_ID",
  "product": "whatsapp-sender",
  "action": "activate veya verify",
  "server_ip": "",
  "timestamp": 1719999999,
  "signature": "hmac"
}
```

### Response

```json
{
  "valid": true,
  "status": "active",
  "message": "Lisans doğrulandı",
  "signature": "hmac"
}
```

---

## 15. Not

Eğer KaenLabs tarafındaki mevcut `verify.php` request formatı biraz farklıysa, backend ya desktop payload’ını buna adapte etmeli ya da Electron uygulama aynı sözleşmeye göre güncellenmelidir. En temiz yöntem, desktop için yukarıdaki sözleşmeyi standart kabul etmektir.

---

## 16. Mevcut gerçek sorun (debug notu)

Şu anda desktop uygulama lisans anahtarını gönderiyor, fakat KaenLabs API isteği daha lisans kontrolüne geçmeden **imza hatası** ile reddediyor.

Yani sorun şurada değil:
- lisans input alanı
- butonun tıklanması
- Electron IPC akışı
- anahtar formatı

Sorun büyük ihtimalle şurada:
- KaenLabs `verify.php` request body'yi farklı formatta bekliyor
- veya HMAC imzayı farklı şekilde hesaplıyor
- veya `signature` alanını ayırmadan tüm body üzerinden kontrol yapıyor
- veya field sırası / JSON encode biçimi desktop tarafıyla birebir aynı değil

Desktop uygulamada test edildiğinde endpoint şu cevabı döndürüyor:

```json
{
  "valid": false,
  "message": "Gecersiz imza.",
  "signature": "..."
}
```

Bu, isteğin sunucuya ulaştığını ama backend'in request signature doğrulamasında kaldığını gösterir.

### Desktop uygulamanın gerçekten gönderdiği payload mantığı

Desktop uygulama aşağıdaki alanları gönderir:

```json
{
  "license_key": "AE51-4D3D-7176-CAAF",
  "domain": "desktop:<installation_id>",
  "product": "whatsapp-sender",
  "action": "activate",
  "server_ip": "",
  "timestamp": 1719999999,
  "signature": "hmac_sha256"
}
```

İmza üretimi şu mantıkla yapılır:

1. Önce `signature` alanı OLMADAN payload oluşturulur
2. Sonra şu hesap yapılır:

```php
$payload = [
  'license_key' => 'AE51-4D3D-7176-CAAF',
  'domain' => 'desktop:INSTALLATION_ID',
  'product' => 'whatsapp-sender',
  'action' => 'activate',
  'server_ip' => '',
  'timestamp' => 1719999999
];

$signature = hash_hmac('sha256', json_encode($payload), LICENSE_SECRET);
```

3. Sonra request body'ye `signature` alanı eklenip JSON olarak POST edilir.

Yani backend doğrulama yaparken:
- ham JSON body okunmalı
- JSON parse edilmeli
- `signature` alanı ayrılmalı
- kalan payload tekrar `json_encode(...)` ile aynı sırada encode edilmeli
- aynı `LICENSE_SECRET` ile `hash_hmac('sha256', ...)` hesaplanmalı
- gelen imza ile karşılaştırılmalı

### Backend tarafında özellikle kontrol edilmesi gerekenler

KaenLabs tarafındaki başka AI / geliştirici şunları kontrol etsin:

1. Request `application/json` olarak mı okunuyor?
   - `$_POST` ile değil, ham body ile okunmalı
   - örnek: `file_get_contents('php://input')`

2. `signature` alanı kontrol öncesi payload'dan çıkarılıyor mu?
   - imza hesaplanırken `signature` alanı dahil edilmemeli

3. `json_encode` ile üretilen string desktop tarafıyla aynı mı?
   - alan isimleri aynı olmalı
   - alan sırası bozulmamalı
   - boş string alanı (`server_ip: ""`) korunmalı

4. Secret birebir aynı mı?

```text
K4eN_L4b5_2026_pr0d_s3cur1ty
```

5. Response da imzalanıyor mu?
   - desktop uygulama response içinde de `signature` bekliyor
   - response HMAC doğrulaması da yapıyor

### KaenLabs tarafı için minimum çalışan request doğrulama örneği

Aşağıdaki örnek mantık desktop uygulama ile uyumludur:

```php
<?php
const LICENSE_SECRET = 'K4eN_L4b5_2026_pr0d_s3cur1ty';

function read_json_request() {
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);

    if (!is_array($data)) {
        return [null, 'Geçersiz JSON body'];
    }

    return [$data, null];
}

function verify_request_signature(array $request): bool {
    $received = isset($request['signature']) ? (string)$request['signature'] : '';
    if ($received === '') {
        return false;
    }

    $payload = $request;
    unset($payload['signature']);

    $expected = hash_hmac('sha256', json_encode($payload), LICENSE_SECRET);
    return hash_equals($expected, $received);
}

function sign_response(array $payload): array {
    $payload['signature'] = hash_hmac('sha256', json_encode($payload), LICENSE_SECRET);
    return $payload;
}

[$request, $error] = read_json_request();

if ($error) {
    echo json_encode(sign_response([
        'valid' => false,
        'status' => 'bad_request',
        'message' => $error
    ]));
    exit;
}

if (!verify_request_signature($request)) {
    echo json_encode(sign_response([
        'valid' => false,
        'status' => 'invalid_signature',
        'message' => 'Gecersiz imza.'
    ]));
    exit;
}

// Buradan sonra lisans bulunup activate/verify mantığı çalıştırılmalı.
```

### Başka AI'a verilecek kısa sorun özeti

> Desktop uygulama lisans isteğini başarıyla gönderiyor ancak KaenLabs `verify.php` endpoint'i request'i `Gecersiz imza.` cevabıyla reddediyor. Sorun UI'da değil, backend request signature doğrulamasında. Backend tarafı `application/json` body'yi ham olarak okuyup `signature` alanını çıkardıktan sonra kalan payload için `hash_hmac('sha256', json_encode($payload), LICENSE_SECRET)` yapmalı. Response tarafı da aynı secret ile imzalanmalı. Desktop payload formatı `license_key`, `domain`, `product`, `action`, `server_ip`, `timestamp`, `signature` alanlarından oluşuyor ve `domain` değeri `desktop:<installation_id>` formatında geliyor.

---

## 17. Hızlı görev cümlesi

Bu kısa metni doğrudan başka AI'a verebilirsiniz:

> KaenLabs `verify.php` endpoint'inde desktop lisans doğrulaması çalışmıyor çünkü Electron uygulamadan gelen JSON request backend tarafından `Gecersiz imza.` ile reddediliyor. UI tarafı çalışıyor; sorun request signature doğrulamasında. Endpoint ham `application/json` body'yi okumalı, `signature` alanını payload'dan çıkarmalı, kalan veriyi `json_encode($payload)` ile aynı sırada encode edip `hash_hmac('sha256', ..., LICENSE_SECRET)` ile doğrulamalı. Ardından `action=activate` ve `action=verify` akışlarını `domain = desktop:<installation_id>` mantığıyla desteklemeli ve response'u da HMAC ile imzalamalı.

Bu düzeltme yapılınca Electron uygulamadaki `Etkinleştir` butonu lisans aktivasyonuna düzgün cevap verecektir.

---

## 18. Desktop uygulamanın ilgili dosyası

Sorun backend'de olsa da desktop uygulamada bu akış şu dosyada uygulanmıştır:

- `electron.js`

Özellikle:
- request imzası üretimi
- response imzası doğrulaması
- `license-activate` IPC handler'ı
- `desktop:<installation_id>` üretimi

Yani backend tarafı bu sözleşmeye uyacak şekilde düzenlenmelidir.

---

## 19. Son durum özeti

Şu anki gerçek durum:

- desktop uygulama lisans penceresini açıyor
- kullanıcı lisans anahtarını girebiliyor
- `Etkinleştir` tıklanınca istek gönderiliyor
- KaenLabs API isteği alıyor
- fakat backend `Gecersiz imza.` cevabı döndürüyor
- bu yüzden aktivasyon tamamlanmıyor

Yani çözülmesi gereken yer artık Electron UI değil, **KaenLabs backend request/response imza uyumu**dur.
