# Çoklu Bağlantı Desteği — Tasarım Spec'i

**Tarih:** 2026-07-02
**Özellik:** MSSQL MCP sunucusunun tek bir veritabanı bağlantısı yerine, isimlendirilmiş birden çok bağlantı profilini (farklı sunucu ve/veya farklı kimlik bilgisi) desteklemesi.
**Durum:** Onay bekliyor (brainstorming + grilling tamamlandı).

---

## 1. Amaç ve Kapsam

### Sorun
Şu an sunucu, ortam değişkenlerinden (`MSSQL_SERVER`, `MSSQL_DATABASE`, `MSSQL_USER`, `MSSQL_PASSWORD`...) **tek bir** yapılandırma okur ve tek bir `ResilientConnectionPool` oluşturur. Bu havuz 19 aracın tümüne parametre olarak geçer. Aynı sunucudaki farklı veritabanlarına `database_name` parametresiyle erişilebiliyor; ama **farklı sunuculara** veya **aynı sunucuya farklı kimliklerle** bağlanmak mümkün değil.

### Hedef
Tek MCP sunucu örneğinin, `.mcp.json` içinde tanımlanmış birden çok isimlendirilmiş bağlantıya erişebilmesi. Her araç çağrısı, isteğe bağlı bir `connection_name` parametresiyle hedef bağlantıyı seçebilir; verilmezse varsayılan bağlantı kullanılır.

### Kapsam dışı (YAGNI)
- Resource katmanının (`mssql://{table}/data`) bağlantı-kapsamlı hale getirilmesi — resource'lar yalnızca varsayılan bağlantı üzerinden çalışır (bkz. D16).
- Çalışma zamanında bağlantı ekleme/çıkarma — bağlantılar yalnızca başlangıçta `MSSQL_CONNECTIONS`'tan okunur.
- Bağlantı sağlık yoklaması (aktif `SELECT 1`) — `list_connections` durum göstermez (bkz. D8).

---

## 2. Yapılandırma

### Format
Tüm bağlantılar `.mcp.json`'ın `env` bloğunda **tek bir `MSSQL_CONNECTIONS`** değişkeninde JSON metni olarak tanımlanır:

```json
{
  "mcpServers": {
    "mssql": {
      "command": "npx",
      "args": ["@bcihanc/mssql-mcp", "--stdio"],
      "env": {
        "MSSQL_CONNECTIONS": "{\"default\":\"uretim\",\"connections\":{\"uretim\":{\"server\":\"prod-sql\",\"database\":\"Sales\",\"user\":\"ro\",\"password\":\"***\"},\"test\":{\"server\":\"test-sql\",\"database\":\"Sales\",\"user\":\"ro\",\"password\":\"***\"}}}"
      }
    }
  }
}
```

Çözülmüş JSON şeması:
```json
{
  "default": "uretim",
  "connections": {
    "uretim": { "server": "prod-sql", "database": "Sales", "user": "ro", "password": "***" },
    "test":   { "server": "test-sql", "database": "Sales", "user": "ro", "password": "***" }
  }
}
```

### Bağlantı başına alanlar
Mevcut `MssqlConfig` ile birebir:
- Zorunlu: `server`, `database` (ve SQL kimlik doğrulama için `user` + `password`).
- Opsiyonel: `port`, `encrypt`, `windowsAuth`. (`windowsAuth: true` ise `user`/`password` gerekmez.)

### Bağlantı adı kuralı
- Regex: `^[a-zA-Z0-9_-]+$` (harf, rakam, alt çizgi, tire). Nokta **yok** — adlar SQL'e enjekte edilmeyen mantıksal etiketlerdir; yalnızca registry anahtarı ve önbellek öneki olarak kullanılır.
- Geçersiz ad → `configError`.

### Geriye dönük uyum (D1)
- `MSSQL_CONNECTIONS` **tanımlıysa** → çoklu-bağlantı modu; eski düz değişkenler (`MSSQL_SERVER` vb.) **tamamen yok sayılır**.
- `MSSQL_CONNECTIONS` **yoksa** → eski tekli mod. Eski değişkenler `"default"` adlı tek bir bağlantı girdisine dönüştürülür. Mevcut kurulumlar hiç dokunulmadan çalışır.

### `default` çözümü (D2)
- 1 bağlantı + `default` alanı yok → o tek bağlantı varsayılan olur.
- Çok bağlantı + `default` yok → `configError` ("`default` belirtilmemiş").
- `default`, `connections` içinde olmayan bir ada işaret ediyor → `configError`.

---

## 3. Mimari

### 3.1 Yapılandırma ayrıştırma — `config.ts` (D12)
Yeni fonksiyon:
```
parseConnectionConfigs(): {
  connections: Map<string, MssqlConfig>,
  defaultName: string
}
```
- `MSSQL_CONNECTIONS` varsa JSON'u ayrıştırır, her girdiyi doğrular, `MssqlConfig`'e dönüştürür.
- Yoksa mevcut `getMssqlConfig()`'i çağırıp tek `"default"` girdisi üretir.
- Ayrıştırma/yapı hataları `Error` fırlatır (çağıran taraf `configError`'a çevirir).

### 3.2 Bağlantı kaydı — `ConnectionRegistry` (D13)
Yeni sınıf (`src/server/ConnectionRegistry.ts`):
- İçinde `Map<string, ResilientConnectionPool>` tutar.
- `constructor(configs: Map<string, MssqlConfig>, defaultName: string)` — her bağlantı için bir `ResilientConnectionPool` **oluşturur ama bağlanmaz** (tembel — D3).
- `get(name?: string): ResilientConnectionPool` — `name` verilmezse `defaultName`; tanımsız ad için hata (tanımlı adları listeler — D5).
- `list(): { name, server, database, user, is_default }[]` — `list_connections` için (şifresiz — D8).
- `closeAll(): Promise<void>` — kapanışta tüm havuzları kapatır.
- `has(name): boolean`, `defaultName` erişimi.

`ResilientConnectionPool` değişikliği: constructor'a `name: string` eklenir, `get name()` erişilebilir olur. Bağlantı mantığı **değişmez**; her havuz bağımsız ve dirençli kalır (tembel yeniden bağlanma zaten var).

### 3.3 Yönlendirme — `MssqlMcpServer` (D6, D15)
- `private pool?` yerine `private registry?: ConnectionRegistry`.
- `CallToolRequestSchema` handler'ı:
  1. `configError` varsa → hata döndür (yalnızca ayrıştırma/yapı hataları buraya düşer — D15).
  2. `registry` yoksa → "henüz başlatılmadı" hatası.
  3. `list_connections` ise → registry'yi doğrudan oku, havuz çözümleme **yapma**.
  4. Aksi halde: `args.connection_name`'i ayıkla (varsa doğrula), `registry.get(name)` ile havuzu bul, kalan `args`'ı mevcut `handleTool(name, args, pool)` imzasına geç.
- Erişilemez bir bağlantı `configError` **değildir**; havuzun `query()`'si tembel yeniden bağlanmayı dener, başarısızsa "veritabanı şu an erişilemez" mesajı döner (mevcut davranış).

### 3.4 `list_connections` aracı (D8)
- 4 sağlayıcıdan birine (`MssqlServerTools` mantıklı) eklenir ama registry'ye ihtiyaç duyduğu için handler'ı registry'yi parametre alır (yönlendirme katmanında özel yol).
- Çıktı alanları: `name`, `server`, `database`, `user`, `is_default`. **Durum yok, şifre yok.** CSV formatında.

### 3.5 Bağlantı kapsamı şeması — `ConnectionScopeSchema` (D7)
Paylaşılan Zod parçası (örn. `src/utils/` veya `config.ts`):
```
const ConnectionScopeSchema = z.object({
  connection_name: z.string().optional()
    .describe("Target connection name. Omit for the default connection. Use list_connections to see available names.")
});
```
Her aracın mevcut Input şeması bununla merge edilir (`.extend()` / merge). Böylece yapay zeka `connection_name`'i her araçta görür.

---

## 4. Önbellek İzolasyonu (Kritik — D4, D14, D18)

### Sorun
Önbellekler 4 dosyada modül düzeyinde statik `Map`. Bağlantı önekiyle anahtarlanmazsa, A sunucusunun sonucu B için servis edilir → yanlış veri + güvenlik sınırı ihlali.

### Çözüm — merkezî anahtar öneki
- Tek yardımcı fonksiyon: her önbellek anahtarının başına `${pool.name}::${dbContext ?? '_default_'}::` öneki koyar.
- `getCacheKey()` (SHA256) ve `buildCacheKeyPrefix(database_name)` bu tek yardımcıda birleşir; **tüm** anahtar kurulumları oradan geçer (birini atlama riski tek noktaya indirilir).
- Araçlar `pool`'u zaten parametre aldığından `pool.name`'e erişebilir — yeni parametre gerekmez.

### `versionCache` düzeltmesi (D14)
`MssqlTools.ts:58`'deki `let versionCache: string | null` tek bir statik string. Çoklu sunucuda **yanlış sürüm** döndürür. Bağlantı-başına anahtarlanan bir `Map<string, string>`'e dönüştürülür.

---

## 5. Güvenlik

- Salt-okunur doğrulama (`isReadOnlyQuery` + `handleQueryError`) her havuz için **aynen** geçerli; hiçbir katman gevşemez.
- Şifreler hiçbir log'a yazılmaz; `list_connections` şifre döndürmez (D9).
- `connection_name` katı regex ile doğrulanır (`^[a-zA-Z0-9_-]+$`); tanımsız ad reddedilir (D5).
- Nesne adı doğrulaması (`validateObjectName`, `validateDatabaseName`) değişmez.

---

## 6. Hata Yönetimi

| Durum | Davranış |
|-------|----------|
| Bozuk `MSSQL_CONNECTIONS` JSON | `configError` — tüm araç çağrıları açıklayıcı hata döndürür |
| Boş `connections` | `configError` |
| `default` geçersiz / eksik (çok bağlantı) | `configError` |
| Geçersiz bağlantı adı biçimi | `configError` |
| `connection_name` tanımsız (çalışma zamanı) | Araç hatası: "Bilinmeyen bağlantı: 'X'. Tanımlı: ..." |
| Bağlantı erişilemez (VPN kapalı vb.) | `configError` **değil**; havuz tembel yeniden bağlanır, araç "erişilemez" der |

---

## 7. Kaynaklar (Resource) Katmanı (D16)

`mssql://{table}/data` resource'ları **yalnızca varsayılan bağlantı** üzerinden çalışır. Çoklu bağlantı erişimi araç-üzerinden (`connection_name`) yapılır. Bu sınır CLAUDE.md/README'de belgelenir.

---

## 8. HTTP `/health` (D17)

- Üst düzey `database` alanı geriye uyum için **varsayılan bağlantının** durumunu yansıtır (`registry.get().isConnected`).
- Ek `connections` dizisi: `[{ name, connected }]` — pasif okuma (`isConnected`, ağa dokunmadan).

---

## 9. Test Planı (D19)

Mevcut standalone-script deseniyle (ts-node ESM loader, test framework yok):
- **Config ayrıştırma:** eski-değişken fallback → tek "default"; `MSSQL_CONNECTIONS` çözümü; `default` çözüm kuralları (1 bağlantı, çok bağlantı, geçersiz `default`); bozuk JSON; boş `connections`.
- **Ad doğrulama:** geçerli/geçersiz `connection_name` biçimleri.
- **Cache izolasyonu:** aynı sorgu iki farklı `pool.name` ile → farklı anahtar, çakışma yok.
- **`list_connections`:** doğru alanlar; şifre sızmıyor.
- **Registry:** `get(undefined)` → default; tanımsız ad → hata; `has`/`list`.

---

## 10. Dokümantasyon (D20)

- `CLAUDE.md`: `MSSQL_CONNECTIONS` formatı, `connection_name` parametresi, `list_connections` aracı, resource-varsayılan-bağlantı sınırı, önbellek bağlantı-namespace'i.
- `README`: `.mcp.json` örneği (çok bağlantılı) + geriye uyum notu.
- `~/.claude/rules/mssql-mcp.md`: araç sayısı 19→20, çoklu bağlantı iş akışı.

---

## 11. Etkilenen Dosyalar (özet)

| Dosya | Değişiklik |
|-------|-----------|
| `src/server/config.ts` | `parseConnectionConfigs()` eklenir |
| `src/server/connection.ts` | `ResilientConnectionPool`'a `name` alanı |
| `src/server/ConnectionRegistry.ts` | **YENİ** — registry sınıfı |
| `src/server/MssqlMcpServer.ts` | `pool` → `registry`; yönlendirmede havuz çözümü; `list_connections` özel yolu |
| `src/utils/identifier.ts` (veya yeni util) | merkezî `cacheKey()` yardımcısı; `ConnectionScopeSchema` |
| `src/MssqlTools.ts` | `versionCache` → Map; cache anahtarları `pool.name` öneki; şema merge |
| `src/MssqlServerTools.ts` | `list_connections` aracı; cache önekleri; şema merge |
| `src/MssqlObjectTools.ts` | cache önekleri; şema merge |
| `src/MssqlProfilingTools.ts` | cache önekleri; şema merge |
| `src/MssqlResources.ts` | varsayılan bağlantı ile çalışır (registry'den default alır) |
| `src/tests/*` | yeni test dosyaları |
| `CLAUDE.md`, `README`, kurallar | dokümantasyon |

---

## 12. Karar Günlüğü

D1–D8 grilling'de kullanıcıyla; D9–D20 kullanıcı yetkisiyle en mantıklı seçenekle karara bağlandı. Ayrıntı için üstteki ilgili bölümler.
