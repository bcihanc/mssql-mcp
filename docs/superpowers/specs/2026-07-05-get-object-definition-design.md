# Tasarım: `get_object_definition` aracı

> Durum: onaylandı (2026-07-05). Kaynak: `docs/HANDOFF-get-object-definition.md`
> (kendi kendine yeten el kitabı) + kod doğrulaması + kapatılan iki tasarım boşluğu.

## Amaç

Bu MSSQL MCP sunucusuna tek jenerik, salt-okunur bir araç ekle: bir stored
procedure / view / function / trigger'ın **tam SQL gövdesini (kaynak kodunu)**
getirsin. Sunucu şu an bu nesneleri yalnızca *listeliyor* (`list_stored_procedures`
vb.); gövde okuma hiç yok.

Fizibilite kanıtlandı: `crm` bağlantısında (`CRMDBPRD02` / `Aytemiz.LMS`, kullanıcı
`LMSReadOnly`) salt-okunur login gövdeyi okuyabiliyor — izin nesne/şema düzeyinde
verilmiş (`HAS_PERMS_BY_NAME(...,'VIEW DEFINITION')=1`), sunucu geneli
`VIEW ANY DEFINITION` gerekmiyor.

## Mimari

Yeni mimari birim yok — mevcut desenlerin ikizi.

- Tek dosya değişir: `src/MssqlObjectTools.ts`. Yeni `handleGetObjectDefinition`
  metodu `handleListProcedures`'ın ikizi gibi kurgulanır.
- `MssqlMcpServer.ts`'e **dokunulmaz**: yönlendirme `MssqlObjectTools.canHandle(name)`
  üzerinden `TOOL_NAMES` Set'ine otomatik bakar.
- Yeniden kullanılan hazır altyapı (yeniden yazma yok):
  - `src/utils/pagination.ts` — `paginateLines` + `formatPaginatedResponse`
    (200 satır varsayılan, 1000 satır tavan; şu an hiçbir araç kullanmıyor, tam
    bu iş için hazır).
  - `src/utils/identifier.ts` — `parseObjectName`, `validateDatabaseName`,
    `namespaceCacheKey`, `buildCacheKeyPrefix`.
  - `src/MssqlObjectTools.ts` içi yardımcılar — cache Map deseni
    (`getFromCache` / `setInCache` / `cleanExpired` / `enforceSizeLimit`),
    `resolveDbScope`, `escapeLiteral`, `plainResponse`, `cachedResponse`,
    `errorResponse`.

## Girdi şeması

```ts
const GetObjectDefinitionInputSchema = DatabaseScopeSchema.extend({
  object_name: z.string().describe('Object name as "schema.name" or just "name" (schema defaults to dbo). e.g. "dbo.GetUsers"'),
  offset_lines: z.number().int().optional().describe('Line offset for pagination (default 0)'),
  max_lines: z.number().int().optional().describe('Max lines to return (default 200, hard cap 1000)'),
});
// getToolDefinitions içinde: .extend(ConnectionScopeSchema.shape) ile connection_name eklenir.
```

## Veri akışı

1. **Girdi doğrulama** (Zod): `object_name` zorunlu; `offset_lines` / `max_lines` /
   `database_name` / `connection_name` opsiyonel.
2. **Ad ayrıştırma:** `parseObjectName(object_name)` → `schema` (yoksa `dbo`) ve
   `object`. **3-parçalı ad (`db.schema.obj`) reddedilir** — net hata mesajı;
   çapraz-DB için `database_name` parametresi kullanılır (`list_*` araçlarıyla
   tutarlı). Gerekçe: `database_name` verilip `object_name` de 3-parçalı gelirse
   ayrıştırılan `database` parçası sessizce yok sayılırdı; kod tabanı bu tür
   "sessiz varsayılan hatası"ndan açıkça kaçınıyor.
3. **Tek sorgu** (çapraz-DB güvenli, `resolveDbScope` `dbPrefix`'i ile):

   ```sql
   SELECT o.type_desc,
          CASE WHEN m.object_id IS NULL THEN 0 ELSE 1 END AS is_module,
          m.definition AS definition
   FROM {dbPrefix}sys.objects o
   INNER JOIN {dbPrefix}sys.schemas s ON o.schema_id = s.schema_id
   LEFT JOIN {dbPrefix}sys.sql_modules m ON o.object_id = m.object_id
   WHERE s.name = '{escaped schema}' AND o.name = '{escaped object}'
   ```

   Not: `OBJECT_DEFINITION(object_id)` yalnızca *mevcut* DB'de çalışır; çapraz-DB
   için `{db}.sys.sql_modules.definition` şarttır — `list_stored_procedures` da
   aynı `dbPrefix` desenini kullanıyor.

4. **NULL-ayrıştırma dalları** (hepsi `plainResponse`, net mesajlar):
   1. **Satır dönmedi** (nesne yok) →
      `Object not found: {schema}.{object}[ in database X].`
   2. **`is_module = 0`** (tablo vb.) →
      `Object '{schema}.{object}' is a {type_desc}; it has no SQL definition (only stored procedures, views, functions, and triggers do).`
   3. **`is_module = 1` ama `definition` NULL** → izin ayrıştır:
      - **Aynı DB** (`database_name` yok): ikinci sorgu
        `SELECT HAS_PERMS_BY_NAME('{schema}.{object}','OBJECT','VIEW DEFINITION') AS has_perm`
        - `has_perm = 0` → `Definition hidden: the connection's login lacks VIEW DEFINITION permission on '{schema}.{object}'. Ask a DBA to GRANT VIEW DEFINITION.`
        - `has_perm = 1` → `Definition is encrypted (WITH ENCRYPTION) and cannot be read.`
      - **Çapraz DB** (`database_name` verilmiş): `HAS_PERMS_BY_NAME` mevcut-DB
        bağlamında güvenilir, çapraz-DB'de değil → ikinci sorguyu **atla**,
        birleşik mesaj ver: izin yoksa `VIEW DEFINITION` gerekir; nesne
        `WITH ENCRYPTION` ile şifreliyse okunamaz.
   4. **`definition` dolu** →
      `paginateLines(definition, { offset_lines, max_lines })` →
      `formatPaginatedResponse(paginated, '{schema}.{object}')` → `plainResponse`.

## Cache

- Yeni `definitionsCache = new Map<string, ToolCacheEntry>()` + sabitler
  (`DEFINITIONS_CACHE_TTL_MS`, `DEFINITIONS_CACHE_MAX_SIZE`; env:
  `MSSQL_DEFINITIONS_CACHE_TTL` / `MSSQL_DEFINITIONS_CACHE_SIZE`) — diğer
  cache'lerle birebir aynı LRU/TTL deseni.
- **Yalnızca başarılı tam gövde cache'lenir** (sayfalanmamış). Tanı mesajları
  (bulunamadı / izin yok / şifreli / no-SQL-definition) **cache'lenmez** — her
  seferinde tazedir. Gerekçe: tanı üretimi ucuz; ayrıca sonradan yaratılan bir
  nesne veya verilen bir `GRANT`, bayat bir "bulunamadı"/"izin yok" yanıtı TTL
  dolana kadar (varsayılan) sürdürmez.
- Cache anahtarı: `namespaceCacheKey(pool.name, \`${scope.dbCacheKey}${schema}.${object}\`)`.
- Okurken cache'ten tam metin alınır, **sonra** `paginateLines` uygulanır — böylece
  her `offset_lines` için ayrı kayıt oluşmaz.
- `clearCachesForTesting()` içine `definitionsCache.clear()` eklenir.

## Hata yönetimi

- Mevcut `try/catch` + `errorResponse('Error getting object definition', error)` deseni.
- `parseObjectName` throw'u (ör. `"a;drop"`, 3-parçalı ad) yakalanıp temiz hata
  yanıtına dönüşür.
- `database_name` `validateDatabaseName` ile korunur; SQL literal'ler `escapeLiteral`
  ile kaçışlanır. Salt-okunur güvenlik sınırı korunur (yalnızca `SELECT`).

## Kayıt (wiring)

- `TOOL_NAMES` Set'ine `'get_object_definition'` eklenir.
- `getToolDefinitions()` dizisine tanım eklenir (açıklama):
  > Get the full SQL definition (source code) of a stored procedure, view, function,
  > or trigger. Returns NULL-safe diagnostics when the definition is inaccessible
  > (missing VIEW DEFINITION permission), encrypted (WITH ENCRYPTION), or the object
  > is not a code module. Supports cross-database via database_name and line-based
  > pagination.
- `handleTool()` switch'ine
  `case 'get_object_definition': return this.handleGetObjectDefinition(args, pool);`
- `handleGetObjectDefinition(args, pool)` metodu eklenir (yukarıdaki akış).

## Test stratejisi

Canlı DB gerektirmeyen birim testleri (`src/tests/object-tools.test.ts`, mevcut
stub-pool deseni). Mevcut stub `query()` yalnızca throw ediyor; NULL-ayrıştırma
dallarını test etmek için `query(sql)`'in dönüşünü **sorgu içeriğine göre** ayarlayan
bir stub gerekir (ana `sys.objects` sorgusu vs. `HAS_PERMS_BY_NAME` takip sorgusu
ayırt edilir; ör. SQL string'inde `HAS_PERMS_BY_NAME` geçip geçmediğine bakılır).

Kapsanan dallar (en az):
- Mutlu yol: dolu definition → sayfalı çıktı + doğru `📄` başlık.
- `is_module = 0` (tablo) → "no SQL definition" mesajı.
- Nesne yok → "Object not found".
- Definition NULL + `has_perm=0` → "lacks VIEW DEFINITION" mesajı.
- Definition NULL + `has_perm=1` → "encrypted (WITH ENCRYPTION)" mesajı.
- 3-parçalı `object_name` (`MyDB.dbo.proc`) → net red hatası.
- Geçersiz `object_name` (ör. `"a;drop"`) → `parseObjectName` throw → temiz hata.

Ayrıca mevcut testlerdeki sabitler güncellenir:
- `canHandle: get_object_definition` → `true`.
- `getToolDefinitions` sayısı `4 → 5`.
- `get_object_definition` `removedTools` listesinden çıkarılır (artık mevcut).

Çalıştırma: `npm run test:object-tools` (tek dosya) ve `npm test` (hepsi, sıralı).

## Build & devreye alma

- `npm run build` → esbuild → `dist/main.mjs`.
- Tüketici `.mcp.json`'lar `dist/main.mjs --stdio` çalıştırır; yeni araç ancak MCP
  reload sonrası görünür.
- Commit: `feat(object-tools): add get_object_definition tool with NULL-safe diagnostics`.

## Dokümantasyon (bitişte zorunlu)

- `README.md` — araç listesine `get_object_definition` eklenir; "definition
  retrieval intentionally not exposed / not available" ifadeleri düzeltilir.
- `CLAUDE.md` — aynı düzeltme; "Object Tools Layer" notu ve araç envanteri güncellenir;
  yeni env değişkenleri (`MSSQL_DEFINITIONS_CACHE_TTL` / `_SIZE`) eklenir.
- **Proje dışı, elle sorulacak:** `~/.claude/rules/mssql-mcp.md` küresel kuralında da
  "Definition retrieval is intentionally not exposed... Don't ask for it." yazıyor.
  Bu dosya tüm projelere ait; **otomatik dokunulmaz** — kullanıcıya "bunu da
  güncelleyeyim mi?" diye sorulur.

## Kapsam dışı (YAGNI)

- Yazma işlemi yok.
- Gövde içinde arama/grep yok.
- Diff yok.
- Definition tipine göre ayrı araç yok (tek jenerik araç dördünü de kapsar).

## Bitti sayılma ölçütü

- [ ] `npm run build` hatasız, `dist/main.mjs` güncellendi.
- [ ] `npm test` hepsi geçti (yeni testler dahil).
- [ ] MCP reload sonrası `get_object_definition` araç listesinde görünüyor.
- [ ] `crm` bağlantısında `object_name="dbo.GetCityAndCountyCodes"` gerçek gövdeyi
      (~356 karakter, `CREATE PROCEDURE ...`) sayfalı başlıkla döndürüyor.
- [ ] Var olmayan nesne → "Object not found"; bir tablo adı → "no SQL definition".
- [ ] README.md ve CLAUDE.md güncellendi; küresel kural için kullanıcıya soruldu.
