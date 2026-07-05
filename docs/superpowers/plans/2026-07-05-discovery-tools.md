# Keşif Araçları Paketi (Paket A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** İki yeni salt-okunur MCP aracı (`search_object_definitions`, `get_object_dependencies`) eklemek ve `get_table_schema` çıktısına MS_Description açıklamalarını taşımak (araç sayısı 21 → 23).

**Architecture:** İki yeni araç `src/MssqlObjectTools.ts`'e, oradaki mevcut private yardımcılar (`resolveDbScope`, `escapeLiteral`, cache dörtlüsü, `plainResponse`/`cachedResponse`/`errorResponse`) yeniden kullanılarak eklenir. Açıklama sütunu `src/MssqlTools.ts` içindeki `handleGetTableSchema` sorgusunun genişletilmesiyle gelir. `MssqlMcpServer.ts`'e dokunulmaz — araç yönlendirmesi `TOOL_NAMES` kümesinden otomatiktir.

**Tech Stack:** TypeScript (ESM), zod/v4, mssql, test çerçevesiz bağımsız ts-node test betikleri, esbuild bundle.

**Spec:** `docs/superpowers/specs/2026-07-05-discovery-tools-design.md`

## Global Constraints

- Sunucu SALT-OKUNURDUR; yeni araçlar yalnızca SELECT üretir. Kullanıcı girdisi SQL'e SADECE tek-tırnak-ikilemeli metin sabiti (`escapeLiteral`) içinde girer.
- `ConnectionPool.query()` `isReadOnlyQuery()` çalıştırmaz (doğrulama yalnızca `exec_sql_csv`'de) — `search_text` içinde "INSERT" gibi kelimeler aranabilir; bu bilinçlidir.
- Kod stili: girinti TAB'dır; SQL sorguları tek satırlık template literal'dir; log çağrıları `if (consola.level >= 0)` korumasıyla yazılır (dosyadaki mevcut stile birebir uy).
- Yeni bağımlılık YOK. Yeni env değişkenleri: `MSSQL_SEARCH_CACHE_TTL` (varsayılan 1800000), `MSSQL_SEARCH_CACHE_SIZE` (100), `MSSQL_DEPS_CACHE_TTL` (7200000), `MSSQL_DEPS_CACHE_SIZE` (100).
- Her görev sonunda `npm test` TÜMÜYLE yeşil olmalı — araç sayısı beklentileri (`multi-connection.test.ts` satır 74 ve `object-tools.test.ts` satır 61) aracı ekleyen görevin İÇİNDE güncellenir.
- Commit mesajları conventional format (`feat(object-tools): ...`, `test: ...`, `docs: ...`).
- Testler gerçek DB bağlantısı KULLANMAZ — sahte havuz (`{ name: 'test', query: async (sql) => ... }`) deseniyle üretilen SQL'i ve dallanmayı doğrular.

---

### Task 1: `search_object_definitions` aracı

**Files:**
- Modify: `src/MssqlObjectTools.ts`
- Modify: `src/tests/object-tools.test.ts`
- Modify: `src/tests/multi-connection.test.ts:74` (21 → 22)

**Interfaces:**
- Consumes: `resolveDbScope(databaseName?)`, `escapeLiteral(s)`, `getFromCache`/`setInCache`, `plainResponse`/`cachedResponse`/`errorResponse`, `formatCSV`, `namespaceCacheKey` — hepsi `src/MssqlObjectTools.ts` içinde/import'unda mevcut.
- Produces: `MssqlObjectTools.handleSearchObjectDefinitions(args, pool)` metodu; `escapeLikePattern(s: string): string` dosya-içi yardımcısı (Task 1'e özel, başka görev kullanmaz); araç adı `search_object_definitions`.

- [ ] **Step 1: Başarısız olacak testleri yaz**

`src/tests/object-tools.test.ts` içinde şu değişiklikleri yap:

1. `expectedTools` dizisine (satır ~37) `'search_object_definitions'` ekle.
2. Satır ~61'deki tanım-sayısı beklentisini güncelle:

```ts
check('exposes 6 tool definitions (4 list tools + get_object_definition + search)', defs.length, 6);
```

3. Dosyanın SONUNA (satır 216'daki özet bloğundan ÖNCE) şu test bölümünü ekle:

```ts
console.log('\n--- search_object_definitions (controlled stub) ---');

// Capture stub: records every SQL text, returns canned rows.
function searchStub(rows: any[]): any {
	const queries: string[] = [];
	return {
		name: 'test',
		queries,
		query: async (sql: string) => {
			queries.push(sql);
			return rows;
		},
	};
}

async function callSearch(args: any, stub: any): Promise<string> {
	MssqlObjectTools.clearCachesForTesting();
	const r = await MssqlObjectTools.handleTool('search_object_definitions', args, stub);
	return r.content[0]?.type === 'text' ? r.content[0].text : '';
}

// Happy path: rows returned as CSV + scope note
{
	const stub = searchStub([{ schema_name: 'dbo', object_name: 'GetUsers', object_type: 'SQL_STORED_PROCEDURE', match_count: 3, modify_date: '2026-01-01' }]);
	const text = await callSearch({ search_text: 'OrderDetail' }, stub);
	checkContains('search happy path: CSV contains object', text, 'GetUsers');
	checkContains('search happy path: scope note appended', text, 'cannot be searched');
	checkContains('search SQL: LIKE with lowered literal', stub.queries[0], "LIKE LOWER('%OrderDetail%') ESCAPE '\\'");
	checkContains('search SQL: TOP 100 limit', stub.queries[0], 'SELECT TOP 100');
}

// Wildcards are escaped -> literal match
{
	const stub = searchStub([]);
	await callSearch({ search_text: '100%_[x]' }, stub);
	checkContains('search SQL: % escaped', stub.queries[0], '\\%');
	checkContains('search SQL: _ escaped', stub.queries[0], '\\_');
	checkContains('search SQL: [ escaped', stub.queries[0], '\\[');
}

// Single quotes are doubled
{
	const stub = searchStub([]);
	await callSearch({ search_text: "a'b" }, stub);
	checkContains('search SQL: quote doubled', stub.queries[0], "a''b");
}

// object_type filter maps to sys.objects type codes
{
	const stub = searchStub([]);
	await callSearch({ search_text: 'x', object_type: 'procedure' }, stub);
	checkContains('search SQL: procedure type filter', stub.queries[0], "o.type IN ('P')");
}
{
	const stub = searchStub([]);
	await callSearch({ search_text: 'x', object_type: 'function' }, stub);
	checkContains('search SQL: function type filter', stub.queries[0], "o.type IN ('FN','IF','TF','AF','FS','FT')");
}

// Whitespace-only search_text rejected (also guards LEN() division by zero)
{
	const text = await callSearch({ search_text: '   ' }, searchStub([]));
	checkContains('whitespace-only search_text rejected', text, 'cannot be empty');
}

// Empty result message
{
	const text = await callSearch({ search_text: 'zzz_yok' }, searchStub([]));
	checkContains('no match message', text, "No objects found containing 'zzz_yok'");
}

// TOP 100 cap note when exactly 100 rows return
{
	const hundred = Array.from({ length: 100 }, (_, i) => ({ schema_name: 'dbo', object_name: `P${i}`, object_type: 'SQL_STORED_PROCEDURE', match_count: 1, modify_date: '2026-01-01' }));
	const text = await callSearch({ search_text: 'x' }, searchStub(hundred));
	checkContains('cap note at 100 rows', text, 'limited to 100');
}

// Cache: second identical call returns cached marker without re-querying
{
	const stub = searchStub([{ schema_name: 'dbo', object_name: 'GetUsers', object_type: 'SQL_STORED_PROCEDURE', match_count: 1, modify_date: '2026-01-01' }]);
	await MssqlObjectTools.handleTool('search_object_definitions', { search_text: 'cached' }, stub); // warm (no clear!)
	const r2 = await MssqlObjectTools.handleTool('search_object_definitions', { search_text: 'cached' }, stub);
	const text2 = r2.content[0]?.type === 'text' ? r2.content[0].text : '';
	checkContains('search cache hit marker', text2, '📋 (Cached result)');
	check('search cache: only one SQL executed', stub.queries.length, 1);
}
```

- [ ] **Step 2: Testlerin BAŞARISIZ olduğunu doğrula**

Çalıştır: `npm run test:object-tools`
Beklenen: FAIL — `canHandle: search_object_definitions` false döner, tanım sayısı 5 ≠ 6, dispatch "Unknown tool" fırlatır.

- [ ] **Step 3: Aracı uygula**

`src/MssqlObjectTools.ts` içinde:

1. Sabitler bloğuna (satır ~26-27 sonrasına) ekle:

```ts
const SEARCH_CACHE_TTL_MS = parseInt(process.env.MSSQL_SEARCH_CACHE_TTL || '1800000', 10);
const SEARCH_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_SEARCH_CACHE_SIZE || '100', 10);
```

2. Cache Map'leri bloğuna (satır ~33 sonrasına) ekle:

```ts
const searchCache = new Map<string, ToolCacheEntry>();
```

3. `GetObjectDefinitionInputSchema`'dan sonra (satır ~90) ekle:

```ts
const SearchObjectDefinitionsInputSchema = DatabaseScopeSchema.extend({
	search_text: z.string().min(1).describe('Plain text to search for inside object definitions (case-insensitive). LIKE wildcards are escaped — the text is matched literally.'),
	object_type: z.enum(['procedure', 'view', 'function', 'trigger']).optional().describe('Optional object type filter. If omitted, all module types are searched.'),
	schema_name: z.string().optional().describe('Optional schema name filter (e.g. "dbo")'),
});
```

4. `TOOL_NAMES` kümesine `'search_object_definitions'` ekle.

5. `escapeLiteral`'dan sonra (satır ~125) dosya-içi yardımcıları ekle:

```ts
function escapeLikePattern(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/[%_\[]/g, (c) => `\\${c}`);
}

const OBJECT_TYPE_FILTERS: Record<string, string> = {
	procedure: `o.type IN ('P')`,
	view: `o.type IN ('V')`,
	function: `o.type IN ('FN','IF','TF','AF','FS','FT')`,
	trigger: `o.type IN ('TR')`,
};

const SEARCH_SCOPE_NOTE = 'ℹ️ Objects whose definition is hidden (missing VIEW DEFINITION permission) or encrypted (WITH ENCRYPTION) cannot be searched.';
```

6. `getToolDefinitions()` dizisine tanım ekle:

```ts
{
	name: 'search_object_definitions',
	description: 'Search for a literal text string inside all stored procedure, view, function, and trigger definitions (case-insensitive). Returns matching objects with match counts — use get_object_definition to read a matching object\'s body. Supports cross-database via database_name.',
	inputSchema: z.toJSONSchema(SearchObjectDefinitionsInputSchema.extend(ConnectionScopeSchema.shape)) as any,
},
```

7. `handleTool()` switch'ine ekle:

```ts
case 'search_object_definitions':
	return this.handleSearchObjectDefinitions(args, pool);
```

8. `handleGetObjectDefinition`'dan sonra handler'ı ekle:

```ts
async handleSearchObjectDefinitions(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
	try {
		const v = SearchObjectDefinitionsInputSchema.parse(args);
		const term = v.search_text.trim();
		if (!term) {
			return plainResponse('search_text cannot be empty or whitespace-only.');
		}
		const scope = resolveDbScope(v.database_name);
		const cacheKey = namespaceCacheKey(pool.name, `${scope.dbCacheKey}${term}:${v.object_type || '_all_'}:${v.schema_name || '_all_'}`);

		const cached = getFromCache(searchCache, cacheKey, SEARCH_CACHE_TTL_MS);
		if (cached !== null) return cachedResponse(cached);

		const lit = escapeLiteral(term);
		const likeLit = escapeLiteral(escapeLikePattern(term));
		const filters: string[] = [];
		if (v.object_type) filters.push(OBJECT_TYPE_FILTERS[v.object_type]);
		if (v.schema_name) filters.push(`s.name = '${escapeLiteral(v.schema_name)}'`);
		const extraWhere = filters.length ? ` AND ${filters.join(' AND ')}` : '';

		const query = `SELECT TOP 100 s.name AS schema_name, o.name AS object_name, o.type_desc AS object_type, (LEN(m.definition) - LEN(REPLACE(LOWER(m.definition), LOWER('${lit}'), ''))) / LEN('${lit}') AS match_count, o.modify_date FROM ${scope.dbPrefix}sys.sql_modules m INNER JOIN ${scope.dbPrefix}sys.objects o ON m.object_id = o.object_id INNER JOIN ${scope.dbPrefix}sys.schemas s ON o.schema_id = s.schema_id WHERE LOWER(m.definition) LIKE LOWER('%${likeLit}%') ESCAPE '\\'${extraWhere} ORDER BY match_count DESC, schema_name, object_name`;

		if (consola.level >= 0) logger.info(`Searching object definitions for "${term}" in ${v.database_name || 'current DB'}`);
		const results = await pool.query(query);
		if (!results || results.length === 0) {
			return plainResponse(`No objects found containing '${term}'.\n\n${SEARCH_SCOPE_NOTE}`);
		}
		let text = formatCSV(results);
		if (results.length === 100) {
			text += '\n\n⚠️ Result limited to 100 objects — narrow the search (object_type / schema_name / database_name) to see the rest.';
		}
		text += `\n\n${SEARCH_SCOPE_NOTE}`;
		setInCache(searchCache, cacheKey, text, SEARCH_CACHE_MAX_SIZE, 'search_object_definitions');
		return plainResponse(text);
	} catch (error) {
		if (consola.level >= 0) logger.error('search_object_definitions error:', error);
		return errorResponse('Error searching object definitions', error);
	}
},
```

9. `clearCachesForTesting()` içine `searchCache.clear();` ekle.

10. `src/tests/multi-connection.test.ts:74` güncelle:

```ts
check('22 tool definitions total', allDefs.length, 22);
```

Dikkat — iki farklı kaçışlama bilinçlidir: `REPLACE(...)` joker tanımaz, bu yüzden `match_count` düz `lit` kullanır; `LIKE` joker tanır, bu yüzden desen `likeLit` (joker + ters bölü kaçışlı) kullanır. TS kaynağında `ESCAPE '\\'` yazımı SQL'e tek `\` olarak iner.

- [ ] **Step 4: Testlerin geçtiğini doğrula**

Çalıştır: `npm run test:object-tools && npm run test:multi-connection`
Beklenen: her ikisi PASS (`process.exit(0)`, "N passed, 0 failed").

- [ ] **Step 5: Tüm test takımını çalıştır**

Çalıştır: `npm test`
Beklenen: 6 test dosyasının tamamı PASS.

- [ ] **Step 6: Commit**

```bash
git add src/MssqlObjectTools.ts src/tests/object-tools.test.ts src/tests/multi-connection.test.ts
git commit -m "feat(object-tools): add search_object_definitions tool"
```

---

### Task 2: `get_object_dependencies` aracı

**Files:**
- Modify: `src/MssqlObjectTools.ts`
- Modify: `src/tests/object-tools.test.ts` (DİKKAT: satır ~49'daki `removedTools` dizisinden `'get_object_dependencies'` ÇIKARILMALI — o testler artık tersine döner)
- Modify: `src/tests/multi-connection.test.ts:74` (22 → 23)

**Interfaces:**
- Consumes: Task 1 ile aynı mevcut yardımcılar + `parseObjectName` (import zaten var).
- Produces: `MssqlObjectTools.handleGetObjectDependencies(args, pool)` metodu; araç adı `get_object_dependencies`; sorgu ayırt etme sözleşmesi (test stub'ları için): uses sorgusu `'uses' AS direction` içerir, used_by sorgusu `'used_by' AS direction` içerir, varlık sorgusu ikisini de içermez.

- [ ] **Step 1: Başarısız olacak testleri yaz**

`src/tests/object-tools.test.ts` içinde:

1. `removedTools` dizisinden (satır ~49) `'get_object_dependencies'` satırını SİL (dizi 5 elemanlı kalır; ona bağlı "removed" testleri otomatik daralır).
2. `expectedTools` dizisine `'get_object_dependencies'` ekle.
3. Tanım-sayısı beklentisini güncelle:

```ts
check('exposes 7 tool definitions (4 list + definition + search + dependencies)', defs.length, 7);
```

4. Dosya sonuna (özet bloğundan önce) ekle:

```ts
console.log('\n--- get_object_dependencies (controlled stub) ---');

// Routes by SQL content: exists-check vs uses vs used_by (see Interfaces contract).
function depsStub(existsRows: any[], usesRows: any[] = [], usedByRows: any[] = []): any {
	const queries: string[] = [];
	return {
		name: 'test',
		queries,
		query: async (sql: string) => {
			queries.push(sql);
			if (sql.includes("'uses' AS direction")) return usesRows;
			if (sql.includes("'used_by' AS direction")) return usedByRows;
			return existsRows;
		},
	};
}

async function callDeps(args: any, stub: any): Promise<string> {
	MssqlObjectTools.clearCachesForTesting();
	const r = await MssqlObjectTools.handleTool('get_object_dependencies', args, stub);
	return r.content[0]?.type === 'text' ? r.content[0].text : '';
}

const usesRow = { direction: 'uses', schema_name: 'dbo', object_name: 'Orders', object_type: 'USER_TABLE', referenced_database: null, is_unresolved: 0 };
const usedByRow = { direction: 'used_by', schema_name: 'dbo', object_name: 'vw_Sales', object_type: 'VIEW', referenced_database: null, is_unresolved: 0 };

// both (default): rows from both queries, three SQL calls (exists + uses + used_by)
{
	const stub = depsStub([{ object_id: 1 }], [usesRow], [usedByRow]);
	const text = await callDeps({ object_name: 'dbo.GetUsers' }, stub);
	checkContains('deps both: uses row present', text, 'Orders');
	checkContains('deps both: used_by row present', text, 'vw_Sales');
	checkContains('deps both: limits note', text, 'Dynamic SQL');
	check('deps both: 3 queries executed', stub.queries.length, 3);
}

// direction=uses: used_by query never executed
{
	const stub = depsStub([{ object_id: 1 }], [usesRow], [usedByRow]);
	const text = await callDeps({ object_name: 'dbo.GetUsers', direction: 'uses' }, stub);
	checkContains('deps uses: uses row present', text, 'Orders');
	check('deps uses: only 2 queries (exists + uses)', stub.queries.length, 2);
	check('deps uses: no used_by SQL', stub.queries.some((q: string) => q.includes("'used_by' AS direction")), false);
}

// Object not found
{
	const text = await callDeps({ object_name: 'dbo.Missing' }, depsStub([]));
	checkContains('deps not found', text, 'Object not found: dbo.Missing');
}

// No recorded dependencies
{
	const text = await callDeps({ object_name: 'dbo.Lonely' }, depsStub([{ object_id: 1 }], [], []));
	checkContains('deps empty message', text, 'No recorded dependencies for dbo.Lonely');
}

// 3-part object_name rejected
{
	const text = await callDeps({ object_name: 'MyDB.dbo.proc' }, depsStub([{ object_id: 1 }]));
	checkContains('deps 3-part rejected', text, 'has 3 parts');
}

// used_by SQL contains name-based unresolved fallback
{
	const stub = depsStub([{ object_id: 1 }], [], []);
	await callDeps({ object_name: 'dbo.Orders', direction: 'used_by' }, stub);
	const usedBySql = stub.queries.find((q: string) => q.includes("'used_by' AS direction"))!;
	checkContains('used_by SQL: id match', usedBySql, "d.referenced_id = OBJECT_ID('dbo.Orders')");
	checkContains('used_by SQL: name fallback', usedBySql, "d.referenced_entity_name = 'Orders'");
	checkContains('used_by SQL: is_unresolved flag computed', usedBySql, 'CASE WHEN d.referenced_id IS NULL THEN 1 ELSE 0 END AS is_unresolved');
}

// Cross-DB: OBJECT_ID gets the 3-part literal
{
	const stub = depsStub([{ object_id: 1 }], [], []);
	await callDeps({ object_name: 'dbo.X', database_name: 'OtherDB', direction: 'uses' }, stub);
	const usesSql = stub.queries.find((q: string) => q.includes("'uses' AS direction"))!;
	checkContains('cross-db OBJECT_ID literal', usesSql, "OBJECT_ID('OtherDB.dbo.X')");
	checkContains('cross-db catalog prefix', usesSql, '[OtherDB].sys.sql_expression_dependencies');
}
```

- [ ] **Step 2: Testlerin BAŞARISIZ olduğunu doğrula**

Çalıştır: `npm run test:object-tools`
Beklenen: FAIL — `canHandle: get_object_dependencies` false, tanım sayısı 6 ≠ 7, dispatch "Unknown tool".

- [ ] **Step 3: Aracı uygula**

`src/MssqlObjectTools.ts` içinde:

1. Sabitlere ekle:

```ts
const DEPS_CACHE_TTL_MS = parseInt(process.env.MSSQL_DEPS_CACHE_TTL || '7200000', 10);
const DEPS_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_DEPS_CACHE_SIZE || '100', 10);
```

2. Cache Map'lere ekle:

```ts
const depsCache = new Map<string, ToolCacheEntry>();
```

3. Girdi şemasını ekle (`SearchObjectDefinitionsInputSchema`'dan sonra):

```ts
const GetObjectDependenciesInputSchema = DatabaseScopeSchema.extend({
	object_name: z.string().describe('Object name as "schema.name" or just "name" (schema defaults to dbo). e.g. "dbo.GetUsers"'),
	direction: z.enum(['uses', 'used_by', 'both']).optional().describe('Dependency direction: what this object uses, what uses this object, or both (default: both)'),
});
```

4. `SEARCH_SCOPE_NOTE`'tan sonra ekle:

```ts
const DEPS_LIMITS_NOTE = "ℹ️ Direct (1-level) dependencies only. Dynamic SQL references (EXEC('...')) are not recorded in the catalog — use search_object_definitions to find those. Encrypted (WITH ENCRYPTION) objects have no recorded dependencies.";
```

5. `TOOL_NAMES` kümesine `'get_object_dependencies'` ekle.

6. `getToolDefinitions()` dizisine tanım ekle:

```ts
{
	name: 'get_object_dependencies',
	description: 'List the direct dependencies of a stored procedure, view, function, or trigger: what it uses and/or what uses it (direction: uses | used_by | both). Based on sys.sql_expression_dependencies; dynamic SQL references are not captured. Supports cross-database via database_name.',
	inputSchema: z.toJSONSchema(GetObjectDependenciesInputSchema.extend(ConnectionScopeSchema.shape)) as any,
},
```

7. `handleTool()` switch'ine ekle:

```ts
case 'get_object_dependencies':
	return this.handleGetObjectDependencies(args, pool);
```

8. Handler'ı ekle (`handleSearchObjectDefinitions`'tan sonra):

```ts
async handleGetObjectDependencies(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
	try {
		const v = GetObjectDependenciesInputSchema.parse(args);
		const parts = parseObjectName(v.object_name);
		if (parts.database) {
			return plainResponse(`Invalid object_name: "${v.object_name}" has 3 parts (database.schema.object). Use the database_name parameter for cross-database access and pass object_name as "schema.name" or "name".`);
		}
		const schema = parts.schema || 'dbo';
		const object = parts.object;
		const direction = v.direction || 'both';
		const scope = resolveDbScope(v.database_name);
		const dbSuffix = v.database_name ? ` in database ${v.database_name}` : '';
		const cacheKey = namespaceCacheKey(pool.name, `${scope.dbCacheKey}${schema}.${object}:${direction}`);

		const cached = getFromCache(depsCache, cacheKey, DEPS_CACHE_TTL_MS);
		if (cached !== null) return cachedResponse(cached);

		const existsQuery = `SELECT o.object_id FROM ${scope.dbPrefix}sys.objects o INNER JOIN ${scope.dbPrefix}sys.schemas s ON o.schema_id = s.schema_id WHERE s.name = '${escapeLiteral(schema)}' AND o.name = '${escapeLiteral(object)}'`;
		if (consola.level >= 0) logger.info(`Getting dependencies for ${schema}.${object} in ${v.database_name || 'current DB'}`);
		const existsRows = await pool.query(existsQuery);
		if (!existsRows || existsRows.length === 0) {
			return plainResponse(`Object not found: ${schema}.${object}${dbSuffix}.`);
		}

		const fullName = escapeLiteral(`${v.database_name ? `${v.database_name}.` : ''}${schema}.${object}`);
		const rows: any[] = [];
		if (direction === 'uses' || direction === 'both') {
			const usesQuery = `SELECT DISTINCT 'uses' AS direction, d.referenced_schema_name AS schema_name, d.referenced_entity_name AS object_name, ro.type_desc AS object_type, d.referenced_database_name AS referenced_database, CASE WHEN d.referenced_id IS NULL THEN 1 ELSE 0 END AS is_unresolved FROM ${scope.dbPrefix}sys.sql_expression_dependencies d LEFT JOIN ${scope.dbPrefix}sys.objects ro ON d.referenced_id = ro.object_id WHERE d.referencing_id = OBJECT_ID('${fullName}')`;
			rows.push(...((await pool.query(usesQuery)) || []));
		}
		if (direction === 'used_by' || direction === 'both') {
			const usedByQuery = `SELECT DISTINCT 'used_by' AS direction, rs.name AS schema_name, ro.name AS object_name, ro.type_desc AS object_type, CAST(NULL AS NVARCHAR(128)) AS referenced_database, CASE WHEN d.referenced_id IS NULL THEN 1 ELSE 0 END AS is_unresolved FROM ${scope.dbPrefix}sys.sql_expression_dependencies d INNER JOIN ${scope.dbPrefix}sys.objects ro ON d.referencing_id = ro.object_id INNER JOIN ${scope.dbPrefix}sys.schemas rs ON ro.schema_id = rs.schema_id WHERE d.referenced_id = OBJECT_ID('${fullName}') OR (d.referenced_id IS NULL AND d.referenced_entity_name = '${escapeLiteral(object)}' AND (d.referenced_schema_name = '${escapeLiteral(schema)}' OR d.referenced_schema_name IS NULL))`;
			rows.push(...((await pool.query(usedByQuery)) || []));
		}

		if (rows.length === 0) {
			return plainResponse(`No recorded dependencies for ${schema}.${object}${dbSuffix} (direction: ${direction}).\n\n${DEPS_LIMITS_NOTE}`);
		}
		const text = `${formatCSV(rows)}\n\n${DEPS_LIMITS_NOTE}`;
		setInCache(depsCache, cacheKey, text, DEPS_CACHE_MAX_SIZE, 'get_object_dependencies');
		return plainResponse(text);
	} catch (error) {
		if (consola.level >= 0) logger.error('get_object_dependencies error:', error);
		return errorResponse('Error getting object dependencies', error);
	}
},
```

9. `clearCachesForTesting()` içine `depsCache.clear();` ekle.

10. `src/tests/multi-connection.test.ts:74` güncelle:

```ts
check('23 tool definitions total', allDefs.length, 23);
```

Notlar: `SELECT DISTINCT` bilinçli — `sys.sql_expression_dependencies` aynı nesne çiftini kolon-düzeyi bağımlılıklarda (referencing_minor_id) birden çok satır olarak verebilir. Sıralama JS tarafında yapılmaz; küçük sonuç kümelerinde katalog sırası yeterli, `direction` sütunu zaten gruplamayı sağlar.

- [ ] **Step 4: Testlerin geçtiğini doğrula**

Çalıştır: `npm run test:object-tools && npm run test:multi-connection`
Beklenen: PASS.

- [ ] **Step 5: Tüm test takımını çalıştır**

Çalıştır: `npm test`
Beklenen: 6 dosya tamamı PASS.

- [ ] **Step 6: Commit**

```bash
git add src/MssqlObjectTools.ts src/tests/object-tools.test.ts src/tests/multi-connection.test.ts
git commit -m "feat(object-tools): add get_object_dependencies tool"
```

---

### Task 3: `get_table_schema`'ya MS_Description açıklamaları

**Files:**
- Modify: `src/MssqlTools.ts:434-509` (`handleGetTableSchema`)
- Create: `src/tests/schema-description.test.ts`
- Modify: `package.json:53` (`test` zincirine yeni dosya) ve script bloğuna `test:schema-description`

**Interfaces:**
- Consumes: `MssqlTools.handleGetTableSchema(args, pool)` (mevcut); `GetTableSchemaInputSchema` DEĞİŞMEZ.
- Produces: `get_table_schema` çıktısında son sütun `[Description]`; tablo açıklaması varsa CSV'nin üstünde `Table description: {metin}` + boş satır. Tablo-açıklama sorgusu `table_description` takma adını içerir (test stub'ları bununla ayırt eder).

- [ ] **Step 1: Başarısız olacak testleri yaz**

`src/tests/schema-description.test.ts` dosyasını oluştur:

```ts
/**
 * Pure-function tests for get_table_schema MS_Description support (no DB required).
 *
 * Uses a capture stub; distinct table names per case avoid cache collisions.
 *
 * Run with: npm run test:schema-description
 */

import { MssqlTools } from '../MssqlTools.js';

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown): void {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) {
		pass++;
		console.log(`✅ ${name}`);
	} else {
		fail++;
		console.error(`❌ ${name}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`);
	}
}

function checkContains(name: string, haystack: string, needle: string): void {
	if (haystack.includes(needle)) {
		pass++;
		console.log(`✅ ${name}`);
	} else {
		fail++;
		console.error(`❌ ${name} — expected to contain "${needle}", got: ${haystack.substring(0, 300)}`);
	}
}

// Column query returns columnRows; the table-description query (contains
// 'table_description') returns descRows. All SQL texts are captured.
function schemaStub(columnRows: any[], descRows: any[]): any {
	const queries: string[] = [];
	return {
		name: 'test',
		queries,
		query: async (sql: string) => {
			queries.push(sql);
			return sql.includes('table_description') ? descRows : columnRows;
		},
	};
}

async function callSchema(tableName: string, stub: any): Promise<string> {
	const r = await MssqlTools.handleGetTableSchema({ table_name: tableName }, stub);
	return r.content[0]?.type === 'text' ? r.content[0].text : '';
}

const colRow = { Column: 'Id', DataType: 'int', MaxLength: null, Nullable: 'NO', Default: null, PrimaryKey: 'YES', ForeignKey: 'NO', UniqueKey: 'NO', Computed: 'NO', ComputedExpression: null, Position: 1, Description: 'Birincil anahtar' };

console.log('\n--- get_table_schema description support ---');

// Main query includes the extended_properties join keyed by column_id (NOT ordinal position)
{
	const stub = schemaStub([colRow], []);
	await callSchema('T1', stub);
	checkContains('main SQL: extended_properties join', stub.queries[0], 'sys.extended_properties');
	checkContains('main SQL: MS_Description filter', stub.queries[0], "ep.name = 'MS_Description'");
	checkContains('main SQL: column_id join (not ordinal)', stub.queries[0], 'ep.minor_id = col.column_id');
	checkContains('main SQL: Description column selected', stub.queries[0], 'AS [Description]');
}

// Description value flows into CSV output
{
	const stub = schemaStub([colRow], []);
	const text = await callSchema('T2', stub);
	checkContains('CSV: Description header present', text, 'Description');
	checkContains('CSV: description value present', text, 'Birincil anahtar');
}

// Table-level description prepended when present
{
	const stub = schemaStub([colRow], [{ table_description: 'Sipariş satırları' }]);
	const text = await callSchema('T3', stub);
	check('table description line first', text.startsWith('Table description: Sipariş satırları'), true);
}

// No table description -> output unchanged (starts with CSV header)
{
	const stub = schemaStub([colRow], []);
	const text = await callSchema('T4', stub);
	check('no description line when absent', text.startsWith('Table description:'), false);
}

// Description query failure is swallowed (graceful degrade)
{
	const queries: string[] = [];
	const stub: any = {
		name: 'test',
		queries,
		query: async (sql: string) => {
			queries.push(sql);
			if (sql.includes('table_description')) throw new Error('EP_DENIED');
			return [colRow];
		},
	};
	const text = await callSchema('T5', stub);
	checkContains('graceful degrade: columns still returned', text, 'Birincil anahtar');
	check('graceful degrade: no error text', text.includes('EP_DENIED'), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
```

`package.json`'a script ekle ve `test` zincirinin SONUNA bağla:

```json
"test": "node --loader ts-node/esm src/tests/error-detection.test.ts && node --loader ts-node/esm src/tests/identifier-pagination.test.ts && node --loader ts-node/esm src/tests/object-tools.test.ts && node --loader ts-node/esm src/tests/server-tools.test.ts && node --loader ts-node/esm src/tests/profiling-tools.test.ts && node --loader ts-node/esm src/tests/multi-connection.test.ts && node --loader ts-node/esm src/tests/schema-description.test.ts",
"test:schema-description": "node --loader ts-node/esm src/tests/schema-description.test.ts"
```

- [ ] **Step 2: Testlerin BAŞARISIZ olduğunu doğrula**

Çalıştır: `npm run test:schema-description`
Beklenen: FAIL — ana sorguda `sys.extended_properties` yok, `Description` sütunu yok.

- [ ] **Step 3: `handleGetTableSchema`'yı genişlet**

`src/MssqlTools.ts:464`'teki sorguda iki değişiklik:

1. Select listesinde `c.ORDINAL_POSITION AS [Position]` ifadesini şununla değiştir (Description son sütun olur):

```
c.ORDINAL_POSITION AS [Position], CAST(ep.value AS NVARCHAR(4000)) AS [Description]
```

2. `LEFT JOIN sys.computed_columns cc ...` parçasından hemen SONRA, `WHERE`'den önce şu iki join'i ekle (tek satır sorgunun içine):

```
 LEFT JOIN sys.columns col ON col.object_id = OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME) AND col.name = c.COLUMN_NAME LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = col.object_id AND ep.minor_id = col.column_id AND ep.name = 'MS_Description'
```

KRİTİK: eşleşme `col.column_id` üzerindendir — `ORDINAL_POSITION` KULLANMA (kolon silinmiş tablolarda ikisi ayrışır, yanlış açıklama gelir). `ep.value` `sql_variant` olduğundan CAST zorunlu.

3. `results` boş-kontrolünden sonra, `const csvText = formatCSV(results);` satırını (satır ~480) şu blokla değiştir:

```ts
let tableDescPrefix = '';
try {
	const descQuery = `SELECT CAST(ep.value AS NVARCHAR(4000)) AS table_description FROM sys.extended_properties ep WHERE ep.class = 1 AND ep.major_id = OBJECT_ID('${schemaName.replace(/'/g, "''")}.${tableName.replace(/'/g, "''")}') AND ep.minor_id = 0 AND ep.name = 'MS_Description'`;
	const descRows = await pool.query(descQuery);
	if (descRows && descRows.length > 0 && descRows[0].table_description) {
		tableDescPrefix = `Table description: ${descRows[0].table_description}\n\n`;
	}
} catch {
	// Extended-property lookup is best-effort; column data must still flow.
}

const csvText = tableDescPrefix + formatCSV(results);
```

Cache mantığına dokunulmaz: `csvText` zaten önek dahil cache'lenir; anahtar formatı aynı kalır (eski kayıtlar TTL — 2 saat — dolunca yeni biçime döner).

- [ ] **Step 4: Testlerin geçtiğini doğrula**

Çalıştır: `npm run test:schema-description`
Beklenen: PASS.

- [ ] **Step 5: Tüm test takımını çalıştır**

Çalıştır: `npm test`
Beklenen: 7 dosya tamamı PASS (yeni dosya dahil).

- [ ] **Step 6: Commit**

```bash
git add src/MssqlTools.ts src/tests/schema-description.test.ts package.json
git commit -m "feat(tools): surface MS_Description extended properties in get_table_schema"
```

---

### Task 4: Dokümantasyon, bundle, temizlik

**Files:**
- Modify: `README.md` (araç listesi + env değişkenleri bölümü)
- Modify: `CLAUDE.md` (Object Tools Layer bölümü, araç envanteri, "Environment Variables" bölümü, araç sayısı geçen yerler: 21 → 23)
- Delete: `docs/HANDOFF-get-object-definition.md` (izlenmeyen artık — işi bitmiş devir-teslim notu)
- Modify: `dist/main.mjs` (build çıktısı — elle DEĞİL, `npm run build` ile)

**Interfaces:**
- Consumes: Task 1-3'ün araç adları ve env değişkenleri (birebir): `search_object_definitions`, `get_object_dependencies`, `[Description]`, `MSSQL_SEARCH_CACHE_TTL/SIZE`, `MSSQL_DEPS_CACHE_TTL/SIZE`.
- Produces: güncel dokümantasyon + deploy edilen bundle.

- [ ] **Step 1: CLAUDE.md güncelle**

"2a. Object Tools Layer" bölümünde "Five tools" → "Seven tools" yap ve iki maddeyi ekle:

```markdown
- `search_object_definitions`: literal, case-insensitive text search inside all module definitions (`sys.sql_modules`). LIKE wildcards in `search_text` are escaped — matches are literal. Optional `object_type` (procedure/view/function/trigger) and `schema_name` filters; TOP 100 cap with a narrow-the-search note. Hidden (no VIEW DEFINITION) and encrypted definitions are NULL in `sys.sql_modules`, so they are silently unsearchable — a note in the output says so. Pairs with `get_object_definition` ("find → read").
- `get_object_dependencies`: direct (1-level) dependencies of a module via `sys.sql_expression_dependencies` — `direction`: `uses` (what it references), `used_by` (what references it, with a name-based fallback for unresolved refs), or `both` (default). Dynamic SQL references are not captured (use `search_object_definitions`); encrypted objects have no recorded dependencies. 3-part `object_name` rejected (use `database_name`).
```

"Environment Variables" bölümündeki Object Tools Caching listesine ekle:

```markdown
- `MSSQL_SEARCH_CACHE_TTL` / `MSSQL_SEARCH_CACHE_SIZE`: search_object_definitions (defaults: 30 min / 100)
- `MSSQL_DEPS_CACHE_TTL` / `MSSQL_DEPS_CACHE_SIZE`: get_object_dependencies (defaults: 2h / 100)
```

`get_table_schema` geçen açıklamalara "(columns, types, constraints including UNIQUE, computed columns, MS_Description descriptions)" notunu işle. "21 dedicated MCP tools" / "21 tool" geçen yerleri 23 yap (`grep -n "21" CLAUDE.md README.md` ile tara; yalnızca araç sayısı bağlamındakileri değiştir).

- [ ] **Step 2: README.md güncelle**

Araç listesine iki yeni aracı (yukarıdaki tek-cümlelik özetlerle) ve `get_table_schema` çıktısındaki `Description` sütununu ekle; env değişkeni tablosuna/listesine 4 yeni değişkeni işle.

- [ ] **Step 3: HANDOFF artığını sil**

```bash
rm docs/HANDOFF-get-object-definition.md
```

(İzlenmeyen dosya — `git rm` gerekmez.)

- [ ] **Step 4: Bundle'ı yeniden derle ve doğrula**

```bash
npm run build
grep -c "search_object_definitions" dist/main.mjs
grep -c "get_object_dependencies" dist/main.mjs
```

Beklenen: build hatasız; her iki grep ≥ 1 döner. (Bundle commit'lenip MCP tarafından çalıştırıldığı için yeniden derleme ZORUNLU — kaynakla eşleşmeyen bundle sessiz regresyondur.)

- [ ] **Step 5: Tüm test takımı + commit**

```bash
npm test
git add README.md CLAUDE.md dist/main.mjs
git commit -m "docs+build: document discovery tools, rebuild bundle"
```

- [ ] **Step 6: Kullanıcıya sorulacaklar (OTOMATİK YAPMA)**

1. `~/.claude/rules/mssql-mcp.md` küresel kuralı "21 dedicated MCP tools" der ve yeni araçları bilmez — tüm projeleri etkilediği için kullanıcıya "güncelleyeyim mi?" diye SOR.
2. Canlı doğrulama (MCP oturumu yeniden yüklendikten sonra, `crm` bağlantısında): bir tablo adı arat → onu kullanan SP'ler listelenmeli; aynı SP için `get_object_dependencies` tutarlı olmalı; açıklama girilmiş tablo varsa `get_table_schema` `[Description]` göstermeli. Bu adım kullanıcının MCP'yi yeniden başlatmasını gerektirir.
