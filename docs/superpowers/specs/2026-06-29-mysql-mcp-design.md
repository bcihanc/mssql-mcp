# MySQL MCP — Tasarım Dokümanı (Spec)

**Tarih:** 2026-06-29
**Durum:** Onaylandı (brainstorming)
**Şablon:** `@bcihanc/mssql-mcp` (bu repo)

## 1. Amaç

`@bcihanc/mssql-mcp` projesinin MySQL karşılığı olan **salt-okunur (read-only)** bir
Model Context Protocol (MCP) sunucusu yazmak. AI asistanlarının (Claude vb.) MySQL
veritabanlarını güvenli biçimde sorgulamasını, gezmesini ve şema incelemesini sağlar.

Salt-okunur = veri okunabilir ama hiçbir yazma işlemi (INSERT/UPDATE/DELETE/DDL)
yapılamaz; bu, birden fazla katmanda zorlanır (güvenlik sınırı).

## 2. Temel Kararlar

| Eksen | Karar | Gerekçe |
|------|-------|---------|
| Paketleme | Ayrı yeni paket: `@bcihanc/mysql-mcp` | En pragmatik; MSSQL projesi şablon alınır, iki kod tabanı bağımsız ilerler |
| Araç kapsamı | Tam eşleşme, MySQL'e uyarlanmış (17 araç) | MSSQL kullanıcısının alıştığı deneyim korunur; MySQL'de anlamsız olanlar düşürülür |
| Read-only zorlaması | Sorgu doğrulaması **+** oturum `READ ONLY` **+** `multipleStatements=false` | Savunma derinliği: uygulama + sürücü + veritabanı seviyesi |
| Schema/DB modeli | Yalnızca `database` kavramı | MySQL'de schema = database; ara `dbo` katmanı yok |
| Hedef sürüm | MySQL 5.7 + 8.x ortak paydası | Yalnızca her iki sürümde de garantili `information_schema` alanları kullanılır |

## 3. Mimari

Mevcut MSSQL projesinin katman yapısı birebir korunur; yalnızca veritabanı sürücüsü
(`mssql` → `mysql2`) ve SQL lehçesi değişir.

### Katmanlar / Dosyalar

- **`src/server/MysqlMcpServer.ts`** — MCP protokol giriş noktası, STDIO + HTTP transport,
  araç yönlendirme (Object → Server → Profiling → Tools sırası).
- **`src/MysqlTools.ts`** — tablo seviyesi metadata + ham SQL:
  `exec_sql_csv`, `get_version`, `list_tables`, `get_table_schema`,
  `get_foreign_keys`, `search_columns`, `get_table_relationships`, `get_table_indexes`
- **`src/MysqlServerTools.ts`** — `list_databases`, `get_server_info`
  *(MSSQL'deki `list_schemas` ve `list_linked_servers` düşürüldü)*
- **`src/MysqlObjectTools.ts`** — `list_stored_procedures`, `list_views`,
  `list_functions`, `list_triggers`
- **`src/MysqlProfilingTools.ts`** — `profile_column`, `get_table_sample`, `get_table_row_count`
- **`src/MysqlResources.ts`** — tabloları MCP resource olarak sunar (`mysql://{table}/data`)
- **`src/server/connection.ts`** — `ResilientConnectionPool` (mysql2 sarmalayıcı)
- **`src/server/config.ts`** — env → config, `isReadOnlyQuery()` çok katmanlı doğrulama
- **`src/utils/*`** — `csv.ts`, `identifier.ts`, `pagination.ts`, `fileLogger.ts`

### Araç sayısı: 19 → 17

Düşürülenler:
- **`list_schemas`** — MySQL'de schema = database; `list_databases` ile aynı olurdu.
- **`list_linked_servers`** — MySQL'de linked server kavramı yok.

## 4. MSSQL → MySQL Eşlemesi (SQL Lehçesi)

| Konu | MSSQL | MySQL |
|------|-------|-------|
| Sistem katalogları | `sys.*`, DMV'ler | `information_schema` (5.7+8 ortak alanlar) |
| Identifier tırnak | `[schema].[table]` | `` `db`.`table` `` |
| Identifier parça | 1–3 parça | **1–2 parça** (`db.table`) |
| Satır limiti | `TOP n` | `LIMIT n` |
| Rastgele sıra | `ORDER BY NEWID()` | `ORDER BY RAND()` |
| Hızlı satır sayısı | 3 katman (`dm_db_partition_stats` → `sysindexes` → `COUNT_BIG`) | **2 katman** (`information_schema.TABLES.TABLE_ROWS` → `COUNT(*)`) |
| FK + cascade | `sys.foreign_keys` | `KEY_COLUMN_USAGE` + `REFERENTIAL_CONSTRAINTS` (`UPDATE_RULE`/`DELETE_RULE`) |
| Sürüm | `@@VERSION` | `VERSION()` / `@@version_comment` |
| Hesaplanan kolon | computed columns | generated columns (`COLUMNS.EXTRA`) |

**Tanım (definition) çekme — kasıtlı olarak yok:** MSSQL projesindeki gibi stored
procedure/view/function/trigger gövdeleri sunulmaz (genelde privilege gerektirir,
salt-okunur kullanıcıda yoktur). Yalnızca listeleme yapılır.

### Araç bazlı uygulama notları

- **list_tables**: `information_schema.TABLES` — `TABLE_ROWS` (InnoDB'de yaklaşık),
  boyut = `DATA_LENGTH + INDEX_LENGTH`; view'ler `TABLE_TYPE='VIEW'`.
- **get_table_schema**: `COLUMNS` (tip, nullable, default, `EXTRA`, `COLUMN_KEY`) +
  `TABLE_CONSTRAINTS`/`KEY_COLUMN_USAGE` (UNIQUE/PK dahil).
- **get_table_indexes**: `information_schema.STATISTICS` (veya `SHOW INDEX`).
- **list_databases**: `information_schema.SCHEMATA` (charset, collation). Sistem DB'lerini
  (`information_schema`, `mysql`, `performance_schema`, `sys`) varsayılan filtreler;
  `include_system=true` ile dahil edilir.
- **get_server_info**: `VERSION()`, `@@version_comment`, `@@hostname` + seçili
  `SHOW VARIABLES`/`SHOW STATUS`. Privilege eksikliğinde alanları zarifçe atlar (MSSQL'deki
  DMV graceful-degradation deseni).
- **profile_column**: null %, distinct, min/max, top 10 (`GROUP BY ... ORDER BY COUNT(*) DESC LIMIT 10`);
  `sample_size` ile `ORDER BY RAND()` örnek alt küme.
- **get_table_sample**: `ORDER BY RAND() LIMIT N` (cap 100, cache yok).
- **get_table_row_count**: `TABLE_ROWS` (hızlı, yaklaşık) → `COUNT(*)` (kesin); `exact=true`
  ilk katmanı atlar.

## 5. Güvenlik Modeli

Mevcut çok katmanlı `isReadOnlyQuery()` korunur (encoding decode, Unicode NFKC normalize,
yorum/backslash strip, dangerous-pattern blacklist, hex detektörü, whitelist starter).

### Uyarlamalar

- **Whitelist başlangıçları**: `SELECT, WITH, SHOW, DESCRIBE, DESC, EXPLAIN`.
- **MySQL'e özgü blacklist eklemeleri** (dosya sızdırma vektörleri):
  `INTO OUTFILE`, `INTO DUMPFILE`, `LOAD_FILE`, `LOAD DATA`.
  Mevcut DDL/DML/DCL/exec/hex/encoding katmanları aynen kalır.
- **Sürücü seviyesi**: `mysql2` havuzunda `multipleStatements: false` → çok-ifadeli enjeksiyon
  sürücüde reddedilir.
- **Veritabanı seviyesi**: her yeni pooled bağlantı açıldığında `SET SESSION TRANSACTION READ ONLY`.
  Autocommit modunda her SELECT kendi işlemi olduğundan bu ayar tüm sorgulara uygulanır.

### Identifier doğrulama

- Regex: 1–2 parça, ASCII alfasayısal + `_` (gerekirse `$`).
- Escape: `` `db`.`table` ``; girişte backtick/köşeli parantez reddedilir.
- Boş parça (`db..table`), 3+ parça, tire, noktalı virgül reddedilir.

## 6. Konfigürasyon

| Env | Açıklama |
|-----|----------|
| `MYSQL_HOST` | Sunucu adresi |
| `MYSQL_PORT` | Port (default 3306) |
| `MYSQL_DATABASE` | Bağlanılacak veritabanı |
| `MYSQL_USER` | Kullanıcı |
| `MYSQL_PASSWORD` | Parola |
| `MYSQL_SSL` | TLS/SSL etkinleştirme |

**Düşen MSSQL'e özel ayarlar:** Windows Auth, LocalDB dönüşümleri, Azure-SQL
otomatik şifreleme (MySQL'de yok).

Performans/cache env'leri MSSQL'deki adlandırmayla korunur (`MSSQL_` → `MYSQL_` öneki),
varsayılan TTL/boyut değerleri aynı.

## 7. Korunan Bileşenler (DB-bağımsız)

Neredeyse değişmeden taşınır:
- `ResilientConnectionPool` — otomatik yeniden bağlanma (exponential backoff 1s→60s),
  thundering-herd koruması, graceful startup
- Cache stratejisi — LRU + lazy TTL cleanup, SHA256 sorgu anahtarı
- CSV utilities (array-join, O(n))
- Pagination utility
- STDIO + HTTP transport (health endpoint, CORS)
- fileLogger
- esbuild bundler (`dist/main.mjs`)

## 8. Test

Mevcut birim testleri uyarla (DB gerektirmeyenler):
- **Sorgu doğrulama**: MSSQL test senaryoları + yeni MySQL blacklist desenleri
  (`INTO OUTFILE`, `LOAD_FILE`, `LOAD DATA`), false-positive regresyon
  (örn. kolon adı "update" içeren WHERE bloklanmamalı).
- **Identifier**: backtick escape, 1–2 parça, geçersiz giriş reddi.
- **Araç-bazlı**: object/server/profiling tool SQL üretim testleri.

## 9. Paket

- Ad: `@bcihanc/mysql-mcp`
- Binary: `mysql-mcp` → `dist/main.mjs`
- `npx @bcihanc/mysql-mcp` ile çalışır
- Sürücü bağımlılığı: `mysql2` (MSSQL'deki `mssql` + `@types/mssql` yerine)

## 10. Kapsam Dışı (YAGNI)

- Yazma işlemleri (tasarım gereği imkânsız)
- Definition (gövde) çekme araçları
- MySQL'e özgü ekstra araçlar (process list, slow query log, engine status) — bu sürümde yok;
  ileride ayrı genişletme olabilir
- Çoklu lehçe / ortak çekirdek soyutlaması (ayrı paket kararı verildi)
