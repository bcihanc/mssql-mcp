# Keşif Araçları Paketi (Paket A) — Tasarım

**Tarih:** 2026-07-05
**Durum:** Onaylandı (kullanıcı ile bölüm bölüm gözden geçirildi)
**Kapsam:** İki yeni araç + bir mevcut araç genişletmesi. Araç sayısı 21 → 23.

## Arka plan ve hedef

`get_object_definition` ile nesne gövdesi okuma eklendi; bu paket onun doğal
devamıdır: gövdelerin **içinde arama**, nesneler arası **bağımlılık çözme** ve
veritabanında dokümante edilmiş **tablo/kolon açıklamalarını** AI'ye taşıma.
Üçü birlikte "bul → oku → ilişkilendir" keşif döngüsünü tamamlar.

Bu paket, kullanıcının seçtiği üç iyileştirme yönünden ilkidir. Sıradakiler
(ayrı spec döngüleriyle): Paket B — performans/teşhis (`get_missing_indexes`,
`get_query_plan`), Paket C — operasyonel sağlamlık (sorgu timeout, `clear_cache`,
resources çoklu bağlantı, çıktı/token verimliliği).

## Yaklaşım kararı

**Mevcut katmanlar genişletilir** (onaylanan Yaklaşım 1):

- İki yeni araç `src/MssqlObjectTools.ts`'e eklenir — oradaki private yardımcılar
  (`resolveDbScope`, `escapeLiteral`, cache dörtlüsü, `plainResponse`/`cachedResponse`/
  `errorResponse`) aynen yeniden kullanılır.
- Açıklama sütunu için `src/MssqlTools.ts` içindeki `get_table_schema` sorgusu değiştirilir.
- `MssqlMcpServer.ts`'e dokunulmaz: `MssqlObjectTools.canHandle()` `TOOL_NAMES`
  kümesine baktığı için yönlendirme otomatiktir.
- Ayrı `MssqlAnalysisTools.ts` katmanı **açılmaz**; ortak yardımcıları `utils`'a
  çıkarma refaktörü ancak Paket B sırasında gerçekten gerekirse yapılır.

Doğrulanmış ön bulgu: `ConnectionPool.query()` (`src/server/connection.ts`)
`isReadOnlyQuery()` çalıştırmaz — o doğrulama yalnızca `exec_sql_csv`'nin ham
kullanıcı SQL'ine uygulanır (`src/MssqlTools.ts:916`). Bu sayede `search_text`
içinde "INSERT" gibi kara-liste kelimeleri aramak güvenlik katmanına takılmaz.
Güvenlik, arama metnini tek-tırnak kaçışlamalı SQL metin sabiti içinde tutarak
sağlanır (mevcut araçlarla aynı desen).

## 1. `search_object_definitions`

Tüm SP/view/function/trigger gövdelerinde metin arar.

### Girdi şeması (Zod, `DatabaseScopeSchema.extend` + `ConnectionScopeSchema.shape`)

- `search_text` (zorunlu): aranacak düz metin. Baştaki/sondaki boşluk kırpılır
  (trim); kırpma sonrası boş kalan metin doğrulamada reddedilir — bu ayrıca
  `match_count` formülündeki `LEN`'in sıfıra bölme riskini de ortadan kaldırır
  (`LEN` sondaki boşlukları saymaz). LIKE joker karakterleri (`%`, `_`, `[`, `\`)
  otomatik kaçışlanır (`ESCAPE` yan tümcesiyle) — kullanıcı ne yazarsa birebir o aranır.
- `object_type` (isteğe bağlı): `procedure` | `view` | `function` | `trigger`.
  Verilmezse dördü birden. Eşleme `sys.objects.type` kodlarıyla:
  procedure → `P`; view → `V`; function → `FN,IF,TF,AF,FS,FT`; trigger → `TR`.
- `schema_name` (isteğe bağlı): şema süzgeci.
- `database_name`, `connection_name`: standart çapraz-DB / çoklu bağlantı.

### Sorgu

```sql
SELECT TOP 100 s.name AS schema_name, o.name AS object_name, o.type_desc AS object_type,
       (LEN(m.definition) - LEN(REPLACE(LOWER(m.definition), LOWER('{esc}'), ''))) / LEN('{esc}') AS match_count,
       o.modify_date
FROM {dbPrefix}sys.sql_modules m
INNER JOIN {dbPrefix}sys.objects o ON m.object_id = o.object_id
INNER JOIN {dbPrefix}sys.schemas s ON o.schema_id = s.schema_id
WHERE LOWER(m.definition) LIKE LOWER('%{escLike}%') ESCAPE '\'
  [AND o.type IN (...)] [AND s.name = '{esc}']
ORDER BY match_count DESC, s.name, o.name
```

- `{esc}` = tek tırnak ikilenmiş metin; `{escLike}` = ek olarak `%`, `_`, `[`, `\`
  karakterleri `\` ile kaçışlanmış hali.
- Büyük/küçük harf duyarsızlık `LOWER()` çiftiyle garanti edilir (collation'a
  bağımlı kalmamak için; `LIKE '%x%'` zaten tam tarama yaptığından ek maliyet ihmal
  edilebilir).
- `TOP 100` sınırına takılırsa çıktıya "aramayı daraltın" notu eklenir.

### Çıktı ve kenar durumları

- CSV: `schema_name, object_name, object_type, match_count, modify_date`.
- **Snippet (eşleşen satır içeriği) bilinçli olarak YOK** — token şişirir; okuma
  işi `get_object_definition`'a bırakılır ("bul → oku" ikilisi).
- Eşleşme yok → `No objects found containing '...'.`
- Çıktı altına kalıcı bilgi notu: VIEW DEFINITION izni olmayan veya
  `WITH ENCRYPTION`'lı nesnelerin gövdesi `sys.sql_modules`'ta NULL olduğundan
  aramada kapsam dışıdır.

### Cache

`searchCache` — aynı LRU/TTL deseni. TTL varsayılan 30 dk, boyut 100.
Env: `MSSQL_SEARCH_CACHE_TTL`, `MSSQL_SEARCH_CACHE_SIZE`.
Anahtar: `namespaceCacheKey(pool.name, `{dbCacheKey}{search_text}:{object_type|_all_}:{schema|_all_}`)`.

## 2. `get_object_dependencies`

Bir nesnenin doğrudan (1 seviye) bağımlılıklarını iki yönde listeler.

### Veri kaynağı kararı

`sys.sql_expression_dependencies` katalog görünümü. `sys.dm_sql_referencing_entities`/
`referenced_entities` bilinçli olarak reddedildi: çağrı anında ad çözmeye çalışır,
bozuk/belirsiz bağımlılıkta hata fırlatır. Katalog görünümü kayıtları hatasız döner,
çözümlenemeyeni `referenced_id = NULL` ile işaretler.

### Girdi şeması

- `object_name` (zorunlu): `"schema.name"` veya `"name"` (varsayılan şema `dbo`).
  3 parçalı ad reddedilir (get_object_definition ile aynı mesaj kalıbı); çapraz DB
  için `database_name` kullanılır.
- `direction` (isteğe bağlı): `uses` | `used_by` | `both` (varsayılan `both`).
- `database_name`, `connection_name`: standart.

### Sorgu mantığı

1. Varlık kontrolü: `{dbPrefix}sys.objects` + `sys.schemas`'tan nesne aranır;
   yoksa `Object not found: {schema}.{object}[ in database X].`
2. *uses*: `WHERE d.referencing_id = OBJECT_ID('{tam ad}')`; karşı taraf
   `{dbPrefix}sys.objects`'e LEFT JOIN (tip için). Çapraz-DB referanslarda
   `referenced_database_name` dolu, tip bilinmez — olduğu gibi raporlanır.
3. *used_by*: `WHERE d.referenced_id = OBJECT_ID('{tam ad}')
   OR (d.referenced_id IS NULL AND d.referenced_entity_name = '{obj}'
   AND (d.referenced_schema_name = '{schema}' OR d.referenced_schema_name IS NULL))`
   — ad-bazlı ek koşul unresolved referansları yakalar. Referans veren taraf
   `sys.objects` + `sys.schemas` JOIN'iyle adlandırılır.
4. `both`: iki sorgu tek CSV'de `direction` sütunuyla birleştirilir (uygulamada
   iki ayrı `pool.query` + satırların birleştirilmesi; `UNION` içeren tek sorgu
   ŞART DEĞİL — tek tek çalıştırmak sade ve yeterli).

### Çıktı ve sınırlar

- CSV: `direction, schema_name, object_name, object_type, referenced_database, is_unresolved`.
- Yalnızca doğrudan bağımlılık; geçişli (transitive) grafik kapsam dışı (YAGNI) —
  AI gerekirse zincirleme çağırır.
- Çıktı altına kalıcı not: dinamik SQL (`EXEC('...')`) referansları katalogda
  görünmez (tamamlayıcısı: `search_object_definitions`); `WITH ENCRYPTION`'lı
  nesnelerin bağımlılık kaydı tutulmaz.
- Kayıt yoksa: `No recorded dependencies for {schema}.{object} (direction: ...).`
  + aynı sınır notu.

### Cache

`depsCache` — TTL varsayılan 2 saat, boyut 100.
Env: `MSSQL_DEPS_CACHE_TTL`, `MSSQL_DEPS_CACHE_SIZE`.
Anahtar: `namespaceCacheKey(pool.name, `{dbCacheKey}{schema}.{object}:{direction}`)`.

## 3. `get_table_schema` genişletmesi — MS_Description açıklamaları

`src/MssqlTools.ts` `handleGetTableSchema` sorgusuna (satır ~464) eklenir:

- `LEFT JOIN sys.columns co ON co.object_id = OBJECT_ID(quoted schema.table)
  AND co.name = c.COLUMN_NAME`
- `LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = co.object_id
  AND ep.minor_id = co.column_id AND ep.name = 'MS_Description'`
- Seçime `CAST(ep.value AS NVARCHAR(4000)) AS [Description]` eklenir (son sütun).

**Kritik doğruluk notu:** eşleşme `column_id` üzerinden yapılır, `ORDINAL_POSITION`
üzerinden DEĞİL — kolon silinmiş tablolarda ikisi ayrışır ve yanlış açıklama gelir.
`ep.value` `sql_variant` olduğundan CAST zorunludur.

**Tablo düzeyi açıklama:** ayrı hafif sorgu
(`... WHERE class = 1 AND major_id = OBJECT_ID(...) AND minor_id = 0 AND name = 'MS_Description'`);
varsa CSV'nin üstüne `Table description: {metin}` satırı eklenir, yoksa çıktı
bugünkü halinin aynısıdır. Geriye uyumlu: yalnızca sona sütun eklenir; açıklamasız
veritabanlarında `[Description]` boş kalır.

Mevcut `schemaCache` aynen kullanılır (anahtar değişmez; TTL dolunca yeni biçim gelir).
`get_table_schema`'ya `database_name` desteği eklemek bu paketin kapsamı dışındadır.

## Kayıt (wiring)

- `TOOL_NAMES` kümesine `search_object_definitions` ve `get_object_dependencies` eklenir.
- `getToolDefinitions()`na iki tanım, `handleTool()` switch'ine iki case.
- `clearCachesForTesting()`na `searchCache.clear()` ve `depsCache.clear()`.
- Araç sayısı 21 → 23; `src/tests/multi-connection.test.ts`'teki araç-sayısı
  beklentisi ve "her araç connection_name taşır" denetimi güncellenir.

## Test planı

Mevcut desen izlenir (test çerçevesi yok; ts-node ile çalışan bağımsız betikler,
sahte havuz / sorgu-yakalama yaklaşımı):

- **Arama:** joker kaçışlama (`%`, `_`, `[` içeren aramalar birebir metne dönüşür),
  tek tırnak (`a'b`), `object_type` → doğru `type IN (...)` eşlemesi, boş sonuç
  mesajı, TOP 100 notu, cache isabet/ıskalama, boş `search_text` reddi.
- **Bağımlılık:** 3 parçalı ad reddi, nesne-yok mesajı, `uses`/`used_by`/`both`
  varyantlarının ürettiği SQL, `is_unresolved` bayrağı, kayıt-yok mesajı.
- **Şema:** `[Description]` sütununun sorguya eklendiği, tablo açıklaması satırının
  yalnızca açıklama varken çıktıya girdiği.

Çalıştırma: `npm run test:object-tools`, `npm test` (tümü).

## Dokümantasyon ve devreye alma

- README.md + proje CLAUDE.md: iki yeni araç, `get_table_schema`'nın yeni
  `[Description]` çıktısı, 4 yeni env değişkeni, araç sayısı 23.
- Küresel kural `~/.claude/rules/mssql-mcp.md` ("21 araç" der): tüm projeleri
  etkilediği için OTOMATİK DOKUNULMAZ — güncelleme kullanıcıya sorulur.
- `npm run build` ile `dist/main.mjs` yeniden derlenir (bundle commit'leniyor ve
  MCP bunu çalıştırıyor); tüketici oturumlarında MCP yeniden yüklenmeden yeni
  araçlar görünmez.
- Temizlik: işi bitmiş `docs/HANDOFF-get-object-definition.md` artığı silinir.

## Bitti sayılma ölçütleri

- [ ] `npm test` tümü geçer (yeni testler dahil); araç sayısı testi 23'ü doğrular.
- [ ] `npm run build` hatasız; bundle'da `search_object_definitions` ve
      `get_object_dependencies` adları geçer.
- [ ] `crm` bağlantısında canlı doğrulama: bir tablo adı aratılınca onu kullanan
      SP'ler listelenir; aynı SP için `get_object_dependencies` tutarlı sonuç verir;
      açıklama girilmiş bir tablo varsa `get_table_schema` `[Description]` gösterir.
- [ ] README/CLAUDE.md güncel; küresel kural için kullanıcıya soruldu.
- [ ] HANDOFF artığı silindi.
