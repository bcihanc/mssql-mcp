# Çoklu Bağlantı Desteği Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MSSQL MCP sunucusuna, `.mcp.json` içindeki tek bir `MSSQL_CONNECTIONS` JSON değişkeninden okunan, isimlendirilmiş birden çok bağlantı profili desteği eklemek; her araç isteğe bağlı `connection_name` ile hedef bağlantıyı seçebilsin.

**Architecture:** `MSSQL_CONNECTIONS` çözülüp `ConnectionRegistry`'ye (`Map<name, ResilientConnectionPool>`, tembel bağlanma) yüklenir. `MssqlMcpServer` her araç çağrısında `connection_name`'e göre doğru havuzu çözer ve mevcut `handleTool(name, args, pool)` imzasına geçer. Önbellek anahtarları `pool.name` ile namespace'lenerek bağlantılar arası veri sızıntısı önlenir.

**Tech Stack:** TypeScript, `mssql` paketi, Zod v4, MCP SDK, ts-node ESM loader (test framework yok — standalone script testleri).

## Global Constraints

- **Salt-okunur (READ-ONLY):** Her bağlantı için `isReadOnlyQuery()` + `handleQueryError()` doğrulaması aynen geçerli; hiçbir katman gevşetilmez.
- **Geriye dönük uyum:** `MSSQL_CONNECTIONS` yoksa eski tekli mod (`MSSQL_SERVER` vb.) aynen çalışır; eski kurulumlar bozulmaz.
- **`MSSQL_CONNECTIONS` varsa eski düz değişkenler tamamen yok sayılır.**
- **Sırlar:** Şifreler hiçbir log'a yazılmaz, `list_connections` şifre döndürmez.
- **Bağlantı adı regex'i:** `^[a-zA-Z0-9_-]+$` (harf, rakam, alt çizgi, tire; nokta yok).
- **Tembel bağlanma:** Hiçbir havuz başlangıçta ağa dokunmaz; ilk kullanımda bağlanır.
- **Test çalıştırma:** `node --loader ts-node/esm src/tests/<dosya>.test.ts`. Tüm testler: `npm test`.
- **TS import uzantısı:** Proje ESM; içe aktarımlarda `.js` uzantısı kullanılır (örn. `from './config.js'`).
- **Zod v4 import:** `import { z } from 'zod/v4';`

---

### Task 1: Bağlantı adı doğrulama + önbellek namespace yardımcısı

**Files:**
- Modify: `src/utils/identifier.ts` (dosya sonuna ekleme)
- Test: `src/tests/multi-connection.test.ts` (Create)

**Interfaces:**
- Produces:
  - `validateConnectionName(name: string): string` — geçerliyse adı döndürür, değilse `throw`.
  - `namespaceCacheKey(connectionName: string, rawKey: string): string` — `"${connectionName}::${rawKey}"`.

- [ ] **Step 1: Testi yaz**

`src/tests/multi-connection.test.ts` dosyasını oluştur:

```typescript
/**
 * Manual tests for multi-connection support.
 * Run with: node --loader ts-node/esm src/tests/multi-connection.test.ts
 */

import { namespaceCacheKey, validateConnectionName } from '../utils/identifier.js';

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

function checkThrows(name: string, fn: () => unknown): void {
	try {
		fn();
		fail++;
		console.error(`❌ ${name} — expected throw, got no error`);
	} catch {
		pass++;
		console.log(`✅ ${name}`);
	}
}

console.log('\n--- validateConnectionName ---');
check('accepts alphanumeric', validateConnectionName('uretim'), 'uretim');
check('accepts underscore', validateConnectionName('prod_1'), 'prod_1');
check('accepts hyphen', validateConnectionName('prod-2'), 'prod-2');
checkThrows('rejects dot', () => validateConnectionName('a.b'));
checkThrows('rejects space', () => validateConnectionName('a b'));
checkThrows('rejects semicolon', () => validateConnectionName('a;b'));
checkThrows('rejects empty', () => validateConnectionName(''));
checkThrows('rejects brackets', () => validateConnectionName('[a]'));

console.log('\n--- namespaceCacheKey ---');
check('prefixes with connection name', namespaceCacheKey('uretim', 'dbo:users'), 'uretim::dbo:users');
check('different names -> different keys',
	namespaceCacheKey('test', 'x') === namespaceCacheKey('uretim', 'x'), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu gör**

Run: `node --loader ts-node/esm src/tests/multi-connection.test.ts`
Expected: FAIL — `namespaceCacheKey`/`validateConnectionName` export edilmedi (import hatası).

- [ ] **Step 3: Yardımcıları ekle**

`src/utils/identifier.ts` dosyasının **sonuna** ekle:

```typescript
// Connection names are logical labels used as registry keys and cache-key
// prefixes — never interpolated into SQL. Dots are disallowed (unlike DB names)
// because they carry no benefit here and keep the label space clean.
const CONNECTION_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a connection name. Returns the name unchanged if valid.
 * @throws Error if the name contains anything other than letters, digits,
 *   underscore, or hyphen.
 */
export function validateConnectionName(name: string): string {
	if (!name || typeof name !== 'string') {
		throw new Error('Connection name must be a non-empty string');
	}
	if (!CONNECTION_NAME_REGEX.test(name)) {
		throw new Error(
			`Invalid connection name: "${name}". Only letters, digits, underscore and hyphen are allowed.`,
		);
	}
	return name;
}

/**
 * Namespace a cache key by connection name so identical query patterns against
 * different connections never collide in the shared static caches.
 */
export function namespaceCacheKey(connectionName: string, rawKey: string): string {
	return `${connectionName}::${rawKey}`;
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini gör**

Run: `node --loader ts-node/esm src/tests/multi-connection.test.ts`
Expected: PASS — tüm satırlar ✅, `10 passed, 0 failed`.

- [ ] **Step 5: package.json'a test script'i ekle**

`package.json` içinde `test` script'inin **sonuna** yeni dosyayı ekle (mevcut zincirin sonuna ` && ...`):

```
"test": "node --loader ts-node/esm src/tests/error-detection.test.ts && node --loader ts-node/esm src/tests/identifier-pagination.test.ts && node --loader ts-node/esm src/tests/object-tools.test.ts && node --loader ts-node/esm src/tests/server-tools.test.ts && node --loader ts-node/esm src/tests/profiling-tools.test.ts && node --loader ts-node/esm src/tests/multi-connection.test.ts",
```

Ve script listesine ekle:

```
"test:multi-connection": "node --loader ts-node/esm src/tests/multi-connection.test.ts",
```

- [ ] **Step 6: Commit**

```bash
git add src/utils/identifier.ts src/tests/multi-connection.test.ts package.json
git commit -m "feat: add connection-name validation and cache-key namespacing helpers"
```

---

### Task 2: Paylaşılan `ConnectionScopeSchema` + 19 araç şemasına merge

**Files:**
- Create: `src/utils/connectionScope.ts`
- Modify: `src/MssqlTools.ts` (getToolDefinitions içindeki 8 girdi), `src/MssqlServerTools.ts` (getToolDefinitions içindeki 4 girdi), `src/MssqlObjectTools.ts` (4 girdi), `src/MssqlProfilingTools.ts` (3 girdi)
- Test: `src/tests/multi-connection.test.ts` (mevcut dosyaya ekleme)

**Interfaces:**
- Consumes: yok
- Produces: `ConnectionScopeSchema` (Zod object, `{ connection_name?: string }`). Diğer görevlerde `<Schema>.extend(ConnectionScopeSchema.shape)` ile birleştirilir.

Not: Sadece **araç tanımlarındaki** (`getToolDefinitions`) `z.toJSONSchema(...)` çağrıları genişletilir — yapay zekanın parametreyi görmesi için. Handler'lardaki `<Schema>.parse(args)` çağrıları **değişmez** (Zod bilinmeyen anahtarları zaten yok sayar; `connection_name` server katmanında ayıklanır).

- [ ] **Step 1: Testi yaz** (`src/tests/multi-connection.test.ts` dosyasına, son `console.log(...pass...)` satırından ÖNCE ekle)

```typescript
import { z } from 'zod/v4';
import { ConnectionScopeSchema } from '../utils/connectionScope.js';

console.log('\n--- ConnectionScopeSchema ---');
{
	const base = z.object({ table_name: z.string() });
	const merged = base.extend(ConnectionScopeSchema.shape);
	const json = z.toJSONSchema(merged) as any;
	check('merged schema exposes connection_name', 'connection_name' in json.properties, true);
	check('merged schema keeps original field', 'table_name' in json.properties, true);
	check('connection_name is optional', (json.required || []).includes('connection_name'), false);
}
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu gör**

Run: `node --loader ts-node/esm src/tests/multi-connection.test.ts`
Expected: FAIL — `../utils/connectionScope.js` bulunamıyor.

- [ ] **Step 3: ConnectionScopeSchema dosyasını oluştur**

`src/utils/connectionScope.ts`:

```typescript
import { z } from 'zod/v4';

/**
 * Shared Zod fragment merged into every tool's input schema so the AI can
 * discover the optional `connection_name` parameter on each tool. Omit it to
 * target the default connection.
 */
export const ConnectionScopeSchema = z.object({
	connection_name: z
		.string()
		.optional()
		.describe('Target connection name. Omit to use the default connection. Use list_connections to see available names.'),
});
```

- [ ] **Step 4: Testi çalıştır, geçtiğini gör**

Run: `node --loader ts-node/esm src/tests/multi-connection.test.ts`
Expected: PASS — yeni 3 satır ✅.

- [ ] **Step 5: MssqlTools.ts — 8 tanımı genişlet**

`src/MssqlTools.ts` başına import ekle (diğer importların yanına):

```typescript
import { ConnectionScopeSchema } from './utils/connectionScope.js';
```

`getToolDefinitions()` içindeki **8** `inputSchema: z.toJSONSchema(<X>) as any` satırını şu kalıba çevir — her birinde şemayı `.extend(ConnectionScopeSchema.shape)` ile sar:

```typescript
// exec_sql_csv
inputSchema: z.toJSONSchema(ExecuteSqlInputSchema.extend(ConnectionScopeSchema.shape)) as any,
// get_version
inputSchema: z.toJSONSchema(GetVersionInputSchema.extend(ConnectionScopeSchema.shape)) as any,
// list_tables
inputSchema: z.toJSONSchema(ListTablesInputSchema.extend(ConnectionScopeSchema.shape)) as any,
// get_table_schema
inputSchema: z.toJSONSchema(GetTableSchemaInputSchema.extend(ConnectionScopeSchema.shape)) as any,
// get_foreign_keys
inputSchema: z.toJSONSchema(GetForeignKeysInputSchema.extend(ConnectionScopeSchema.shape)) as any,
// search_columns
inputSchema: z.toJSONSchema(SearchColumnsInputSchema.extend(ConnectionScopeSchema.shape)) as any,
// get_table_relationships
inputSchema: z.toJSONSchema(GetTableRelationshipsInputSchema.extend(ConnectionScopeSchema.shape)) as any,
// get_table_indexes
inputSchema: z.toJSONSchema(GetTableIndexesInputSchema.extend(ConnectionScopeSchema.shape)) as any,
```

- [ ] **Step 6: MssqlServerTools.ts — 4 tanımı genişlet**

`src/MssqlServerTools.ts` başına import ekle:

```typescript
import { ConnectionScopeSchema } from './utils/connectionScope.js';
```

`getToolDefinitions()` içindeki 4 girdiyi genişlet:

```typescript
// list_databases
inputSchema: z.toJSONSchema(ListDatabasesInputSchema.extend(ConnectionScopeSchema.shape)) as any,
// list_schemas
inputSchema: z.toJSONSchema(ListSchemasInputSchema.extend(ConnectionScopeSchema.shape)) as any,
// list_linked_servers
inputSchema: z.toJSONSchema(ListLinkedServersInputSchema.extend(ConnectionScopeSchema.shape)) as any,
// get_server_info
inputSchema: z.toJSONSchema(GetServerInfoInputSchema.extend(ConnectionScopeSchema.shape)) as any,
```

- [ ] **Step 7: MssqlObjectTools.ts ve MssqlProfilingTools.ts — kalan 7 tanımı genişlet**

Her iki dosyanın başına import ekle:

```typescript
import { ConnectionScopeSchema } from './utils/connectionScope.js';
```

`src/MssqlObjectTools.ts` — `getToolDefinitions()` içindeki 4 girdinin her `inputSchema` satırını, ilgili şemayı `.extend(ConnectionScopeSchema.shape)` ile sararak güncelle (list_stored_procedures, list_views, list_functions, list_triggers şemaları).

`src/MssqlProfilingTools.ts` — `getToolDefinitions()` içindeki 3 girdiyi aynı şekilde güncelle (profile_column, get_table_sample, get_table_row_count şemaları).

Her satır kalıbı: `inputSchema: z.toJSONSchema(<ŞemaAdı>.extend(ConnectionScopeSchema.shape)) as any,`

- [ ] **Step 8: Derleme kontrolü**

Run: `npx tsc --noEmit`
Expected: Hata yok.

- [ ] **Step 9: Commit**

```bash
git add src/utils/connectionScope.ts src/MssqlTools.ts src/MssqlServerTools.ts src/MssqlObjectTools.ts src/MssqlProfilingTools.ts src/tests/multi-connection.test.ts
git commit -m "feat: expose optional connection_name on all tool definitions"
```

---

### Task 3: `parseConnectionConfigs()` — yapılandırma ayrıştırma

**Files:**
- Modify: `src/server/config.ts`
- Test: `src/tests/multi-connection.test.ts`

**Interfaces:**
- Consumes: `validateConnectionName` (Task 1), mevcut `MssqlConfig`, `getMssqlConfig()`
- Produces:
  - `interface ParsedConnections { connections: Map<string, MssqlConfig>; defaultName: string; }`
  - `parseConnectionConfigs(env?: NodeJS.ProcessEnv): ParsedConnections` — hata durumunda `throw`.
  - `normalizeMssqlConfig(raw: MssqlConfig): MssqlConfig` — LocalDB/Azure/encrypt normalizasyonu.

- [ ] **Step 1: Testi yaz** (multi-connection.test.ts'e, pass/fail özet satırından önce ekle)

```typescript
import { parseConnectionConfigs } from '../server/config.js';

console.log('\n--- parseConnectionConfigs ---');
{
	// Legacy fallback: no MSSQL_CONNECTIONS -> single "default"
	const legacyEnv = {
		MSSQL_SERVER: 'legacy-host', MSSQL_DATABASE: 'db', MSSQL_USER: 'u', MSSQL_PASSWORD: 'p',
	} as any;
	const legacy = parseConnectionConfigs(legacyEnv);
	check('legacy -> defaultName is default', legacy.defaultName, 'default');
	check('legacy -> one connection', legacy.connections.size, 1);
	check('legacy -> default server', legacy.connections.get('default')?.server, 'legacy-host');
}
{
	// Multi with explicit default
	const env = {
		MSSQL_CONNECTIONS: JSON.stringify({
			default: 'uretim',
			connections: {
				uretim: { server: 'prod', database: 'S', user: 'u', password: 'p' },
				test: { server: 'test', database: 'S', user: 'u', password: 'p' },
			},
		}),
	} as any;
	const parsed = parseConnectionConfigs(env);
	check('multi -> defaultName', parsed.defaultName, 'uretim');
	check('multi -> two connections', parsed.connections.size, 2);
	check('multi -> test server', parsed.connections.get('test')?.server, 'test');
}
{
	// Single connection, no default -> auto default
	const env = {
		MSSQL_CONNECTIONS: JSON.stringify({
			connections: { only: { server: 'x', database: 'S', user: 'u', password: 'p' } },
		}),
	} as any;
	const parsed = parseConnectionConfigs(env);
	check('single no-default -> auto default', parsed.defaultName, 'only');
}
checkThrows('multi no-default -> throws', () => parseConnectionConfigs({
	MSSQL_CONNECTIONS: JSON.stringify({
		connections: {
			a: { server: 'x', database: 'S', user: 'u', password: 'p' },
			b: { server: 'y', database: 'S', user: 'u', password: 'p' },
		},
	}),
} as any));
checkThrows('default points to missing -> throws', () => parseConnectionConfigs({
	MSSQL_CONNECTIONS: JSON.stringify({
		default: 'nope',
		connections: { a: { server: 'x', database: 'S', user: 'u', password: 'p' } },
	}),
} as any));
checkThrows('malformed JSON -> throws', () => parseConnectionConfigs({
	MSSQL_CONNECTIONS: '{not valid json',
} as any));
checkThrows('empty connections -> throws', () => parseConnectionConfigs({
	MSSQL_CONNECTIONS: JSON.stringify({ connections: {} }),
} as any));
checkThrows('invalid connection name -> throws', () => parseConnectionConfigs({
	MSSQL_CONNECTIONS: JSON.stringify({
		connections: { 'bad name': { server: 'x', database: 'S', user: 'u', password: 'p' } },
	}),
} as any));
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu gör**

Run: `node --loader ts-node/esm src/tests/multi-connection.test.ts`
Expected: FAIL — `parseConnectionConfigs` export edilmedi.

- [ ] **Step 3: `normalizeMssqlConfig` ve `parseConnectionConfigs`'i ekle**

`src/server/config.ts` başındaki import satırına `validateConnectionName`'i ekle:

```typescript
import { validateConnectionName, validateObjectName } from '../utils/identifier.js';
```

Dosyanın **sonuna** ekle:

```typescript
export interface ParsedConnections {
	connections: Map<string, MssqlConfig>;
	defaultName: string;
}

/**
 * Apply LocalDB conversion and Azure/encrypt normalization to a raw config.
 * Shared by getMssqlConfig() and parseConnectionConfigs() so both paths behave
 * identically.
 */
export function normalizeMssqlConfig(raw: MssqlConfig): MssqlConfig {
	let server = raw.server || 'localhost';
	if (server.toLowerCase().includes('(localdb)')) {
		const instanceName = server.replace(/\(localdb\)\\{1,2}/i, '');
		server = `.\\${instanceName}`;
	}
	let encrypt = raw.encrypt;
	if (server.includes('.database.windows.net')) {
		encrypt = true;
	}
	return { ...raw, server, encrypt };
}

interface RawConnectionEntry {
	server?: string;
	database?: string;
	user?: string;
	password?: string;
	port?: number;
	encrypt?: boolean;
	windowsAuth?: boolean;
}

/**
 * Parse multi-connection configuration.
 *
 * - If `MSSQL_CONNECTIONS` is set: parse it as JSON, validate each entry, and
 *   resolve the default connection name.
 * - Otherwise: fall back to the legacy single-connection env vars, exposed as a
 *   single connection named "default".
 *
 * @throws Error on malformed JSON, empty connections, invalid names, or an
 *   unresolvable default. Callers surface this as a configuration error.
 */
export function parseConnectionConfigs(env: NodeJS.ProcessEnv = process.env): ParsedConnections {
	const raw = env.MSSQL_CONNECTIONS;

	// Legacy single-connection fallback
	if (!raw) {
		const legacy = getMssqlConfig();
		const connections = new Map<string, MssqlConfig>();
		connections.set('default', legacy);
		return { connections, defaultName: 'default' };
	}

	let parsed: { default?: string; connections?: Record<string, RawConnectionEntry> };
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`MSSQL_CONNECTIONS is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`,
		);
	}

	if (!parsed || typeof parsed !== 'object' || !parsed.connections || typeof parsed.connections !== 'object') {
		throw new Error('MSSQL_CONNECTIONS must be an object with a non-empty "connections" map.');
	}

	const names = Object.keys(parsed.connections);
	if (names.length === 0) {
		throw new Error('MSSQL_CONNECTIONS "connections" map is empty — define at least one connection.');
	}

	const connections = new Map<string, MssqlConfig>();
	for (const name of names) {
		validateConnectionName(name); // throws on invalid name
		const entry = parsed.connections[name];
		if (!entry || !entry.server || !entry.database) {
			throw new Error(`Connection "${name}" is missing required "server" or "database".`);
		}
		const windowsAuth = entry.windowsAuth === true;
		if (!windowsAuth && (!entry.user || !entry.password)) {
			throw new Error(`Connection "${name}" requires "user" and "password" (or "windowsAuth": true).`);
		}
		const config: MssqlConfig = normalizeMssqlConfig({
			server: entry.server,
			database: entry.database,
			user: windowsAuth ? undefined : entry.user,
			password: windowsAuth ? undefined : entry.password,
			port: entry.port ?? 1433,
			encrypt: entry.encrypt ?? false,
			command: process.env.MSSQL_COMMAND || 'execute_sql',
			windowsAuth,
		});
		connections.set(name, config);
	}

	// Resolve default
	let defaultName: string;
	if (parsed.default) {
		if (!connections.has(parsed.default)) {
			throw new Error(
				`MSSQL_CONNECTIONS "default" points to "${parsed.default}", which is not a defined connection. Defined: ${names.join(', ')}.`,
			);
		}
		defaultName = parsed.default;
	} else if (names.length === 1) {
		defaultName = names[0];
	} else {
		throw new Error(
			`MSSQL_CONNECTIONS defines multiple connections but no "default". Add a "default" naming one of: ${names.join(', ')}.`,
		);
	}

	return { connections, defaultName };
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini gör**

Run: `node --loader ts-node/esm src/tests/multi-connection.test.ts`
Expected: PASS — tüm parseConnectionConfigs satırları ✅.

Not: Bu test `getMssqlConfig()`'i legacy env ile çağırır; `getMssqlConfig` `process.env`'i okuduğu için legacy testte `process.env`'e değil parametreye güvenemeyiz. **Düzeltme:** `parseConnectionConfigs`'in legacy dalı `getMssqlConfig()`'i çağırır ve o `process.env`'i okur. Testin legacy dalını doğru çalıştırmak için legacy test bloğunu şu şekilde process.env set/restore ile sar:

```typescript
{
	const saved = { ...process.env };
	process.env.MSSQL_SERVER = 'legacy-host';
	process.env.MSSQL_DATABASE = 'db';
	process.env.MSSQL_USER = 'u';
	process.env.MSSQL_PASSWORD = 'p';
	delete process.env.MSSQL_CONNECTIONS;
	const legacy = parseConnectionConfigs();
	check('legacy -> defaultName is default', legacy.defaultName, 'default');
	check('legacy -> one connection', legacy.connections.size, 1);
	check('legacy -> default server', legacy.connections.get('default')?.server, 'legacy-host');
	process.env = saved;
}
```

(Step 1'deki legacy bloğunu bununla değiştir.)

- [ ] **Step 5: Derleme kontrolü**

Run: `npx tsc --noEmit`
Expected: Hata yok.

- [ ] **Step 6: Commit**

```bash
git add src/server/config.ts src/tests/multi-connection.test.ts
git commit -m "feat: parse multi-connection config with legacy fallback"
```

---

### Task 4: `ConnectionPool.name` + `ConnectionRegistry` + `resolvePoolForCall`

**Files:**
- Modify: `src/server/connection.ts` (`ConnectionPool` arayüzü + `ResilientConnectionPool` + `createResilientConnectionPool` + deprecated `createConnectionPool`)
- Create: `src/server/ConnectionRegistry.ts`
- Test: `src/tests/multi-connection.test.ts`

**Interfaces:**
- Consumes: `ParsedConnections` (Task 3), `ResilientConnectionPool`, `createResilientConnectionPool`, `validateConnectionName` (Task 1)
- Produces:
  - `ConnectionPool` arayüzüne `name: string` alanı.
  - `ResilientConnectionPool` constructor: `(config, name)`, `get name(): string`.
  - `createResilientConnectionPool(config, name)`.
  - `interface ConnectionInfo { name: string; server: string; database: string; user: string; is_default: boolean; }`
  - `class ConnectionRegistry` — `constructor(parsed: ParsedConnections)`, `get(name?: string): ResilientConnectionPool`, `has(name: string): boolean`, `list(): ConnectionInfo[]`, `closeAll(): Promise<void>`, `readonly defaultName: string`.
  - `resolvePoolForCall(registry: ConnectionRegistry, args: any): ResilientConnectionPool`.

- [ ] **Step 1: Testi yaz** (multi-connection.test.ts'e ekle)

```typescript
import { ConnectionRegistry, resolvePoolForCall } from '../server/ConnectionRegistry.js';

console.log('\n--- ConnectionRegistry ---');
{
	const parsed = parseConnectionConfigs({
		MSSQL_CONNECTIONS: JSON.stringify({
			default: 'uretim',
			connections: {
				uretim: { server: 'prod', database: 'S', user: 'u', password: 'p' },
				test: { server: 'test', database: 'S', user: 'v', password: 'p' },
			},
		}),
	} as any);
	const registry = new ConnectionRegistry(parsed);

	check('get() -> default pool name', registry.get().name, 'uretim');
	check('get("test") -> named pool', registry.get('test').name, 'test');
	check('has known', registry.has('test'), true);
	check('has unknown', registry.has('nope'), false);
	checkThrows('get unknown -> throws', () => registry.get('nope'));

	const list = registry.list();
	check('list length', list.length, 2);
	const uretim = list.find((c) => c.name === 'uretim')!;
	check('list exposes server', uretim.server, 'prod');
	check('list exposes user', uretim.user, 'u');
	check('list marks default', uretim.is_default, true);
	check('list has no password field', 'password' in (uretim as any), false);

	// resolvePoolForCall
	check('resolve no arg -> default', resolvePoolForCall(registry, {}).name, 'uretim');
	check('resolve named', resolvePoolForCall(registry, { connection_name: 'test' }).name, 'test');
	checkThrows('resolve invalid name -> throws', () => resolvePoolForCall(registry, { connection_name: 'bad name' }));
	checkThrows('resolve unknown name -> throws', () => resolvePoolForCall(registry, { connection_name: 'nope' }));
}
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu gör**

Run: `node --loader ts-node/esm src/tests/multi-connection.test.ts`
Expected: FAIL — `../server/ConnectionRegistry.js` yok.

- [ ] **Step 3: `ConnectionPool` arayüzüne `name` ekle ve `ResilientConnectionPool`'a `name` ver**

`src/server/connection.ts` — `ConnectionPool` arayüzünü güncelle:

```typescript
export interface ConnectionPool {
	name: string;
	query<T = any>(sqlQuery: string): Promise<T[]>;
	close(): Promise<void>;
}
```

`ResilientConnectionPool` sınıfına `name` alanı ekle. Constructor'ı güncelle:

```typescript
	private readonly connectionName: string;

	/** The logical connection name this pool serves (registry key, cache prefix). */
	get name(): string {
		return this.connectionName;
	}

	constructor(config: LocalMssqlConfig, name: string = 'default') {
		this.connectionName = name;
		this.localConfig = config;
		this.mssqlConfig = buildMssqlConfig(config);

		const fileLogger = getFileLogger();
		if (consola.level >= 0) {
			logger.info('Connection configured for READ-ONLY access mode (write operations are disabled)');
		}
		fileLogger.info('ResilientConnectionPool created (READ-ONLY mode)');
	}
```

`createResilientConnectionPool` imzasını güncelle:

```typescript
export function createResilientConnectionPool(config: LocalMssqlConfig, name: string = 'default'): ResilientConnectionPool {
	const fileLogger = getFileLogger();
	fileLogger.info('createResilientConnectionPool() called', {
		connection: name,
		server: config.server,
		database: config.database,
		port: config.port,
		windowsAuth: config.windowsAuth,
		encrypt: config.encrypt,
	});
	return new ResilientConnectionPool(config, name);
}
```

Deprecated `createConnectionPool`'un döndürdüğü nesne literaline `name` ekle (arayüz uyumu için). `return { async query..., async close... }` bloğunu şununla değiştir — bloğun başına `name` ekle:

```typescript
	return {
		name: 'default',
		async query<T = any>(sqlQuery: string): Promise<T[]> {
```

(Geri kalan `query`/`close` gövdesi aynen kalır.)

- [ ] **Step 4: `ConnectionRegistry.ts`'i oluştur**

`src/server/ConnectionRegistry.ts`:

```typescript
import { validateConnectionName } from '../utils/identifier.js';
import type { MssqlConfig } from './config.js';
import type { ParsedConnections } from './config.js';
import { createResilientConnectionPool, ResilientConnectionPool } from './connection.js';

export interface ConnectionInfo {
	name: string;
	server: string;
	database: string;
	user: string;
	is_default: boolean;
}

/**
 * Holds one ResilientConnectionPool per named connection. Pools are created but
 * NOT connected here — each connects lazily on its first query (VPN-friendly:
 * an unreachable connection never spins background retries until it is used).
 */
export class ConnectionRegistry {
	private readonly pools = new Map<string, ResilientConnectionPool>();
	private readonly configs = new Map<string, MssqlConfig>();
	readonly defaultName: string;

	constructor(parsed: ParsedConnections) {
		this.defaultName = parsed.defaultName;
		for (const [name, config] of parsed.connections) {
			this.configs.set(name, config);
			this.pools.set(name, createResilientConnectionPool(config, name));
		}
	}

	/** Resolve a pool by name; falls back to the default connection when name is omitted. */
	get(name?: string): ResilientConnectionPool {
		const target = name ?? this.defaultName;
		const pool = this.pools.get(target);
		if (!pool) {
			throw new Error(
				`Unknown connection: "${target}". Defined connections: ${[...this.pools.keys()].join(', ')}.`,
			);
		}
		return pool;
	}

	has(name: string): boolean {
		return this.pools.has(name);
	}

	/** Public connection metadata for list_connections. NEVER includes passwords. */
	list(): ConnectionInfo[] {
		const out: ConnectionInfo[] = [];
		for (const [name, config] of this.configs) {
			out.push({
				name,
				server: config.server,
				database: config.database,
				user: config.user ?? (config.windowsAuth ? '(Windows Auth)' : ''),
				is_default: name === this.defaultName,
			});
		}
		return out;
	}

	async closeAll(): Promise<void> {
		for (const pool of this.pools.values()) {
			try {
				await pool.close();
			} catch {
				/* ignore individual close errors */
			}
		}
	}
}

/**
 * Resolve the target pool for a tool call from its args. Extracts and validates
 * `connection_name`; omitted -> default connection.
 * @throws Error on invalid name format or unknown connection.
 */
export function resolvePoolForCall(registry: ConnectionRegistry, args: any): ResilientConnectionPool {
	const raw = args?.connection_name;
	if (raw === undefined || raw === null) {
		return registry.get();
	}
	const name = validateConnectionName(String(raw)); // throws on bad format
	return registry.get(name); // throws on unknown
}
```

- [ ] **Step 5: Testi çalıştır, geçtiğini gör**

Run: `node --loader ts-node/esm src/tests/multi-connection.test.ts`
Expected: PASS — ConnectionRegistry satırlarının hepsi ✅.

Not: `new ResilientConnectionPool(config, name)` constructor'ı bağlanmaz (tembel), bu yüzden test gerçek DB olmadan çalışır.

- [ ] **Step 6: Derleme kontrolü**

Run: `npx tsc --noEmit`
Expected: Hata yok.

- [ ] **Step 7: Commit**

```bash
git add src/server/connection.ts src/server/ConnectionRegistry.ts src/tests/multi-connection.test.ts
git commit -m "feat: add ConnectionRegistry and pool identity (name)"
```

---

### Task 5: Önbellek anahtarlarını `pool.name` ile namespace'le + `versionCache` Map'e çevir

**Files:**
- Modify: `src/MssqlTools.ts`, `src/MssqlServerTools.ts`, `src/MssqlObjectTools.ts`, `src/MssqlProfilingTools.ts`
- Test: `src/tests/multi-connection.test.ts`

**Interfaces:**
- Consumes: `namespaceCacheKey` (Task 1), `ConnectionPool.name` (Task 4)

**Kural:** Her araç handler'ında, önbelleğe yazılan/okunan anahtar `namespaceCacheKey(pool.name, <mevcutAnahtar>)` ile sarılır. `versionCache` tek string yerine `Map<string, string>` olur ve `pool.name` ile anahtarlanır.

- [ ] **Step 1: Testi yaz** — iki farklı adlı sahte pool ile çapraz-servis olmadığını doğrula (multi-connection.test.ts'e ekle)

```typescript
import { MssqlTools } from '../MssqlTools.js';

console.log('\n--- cache isolation (get_version) ---');
{
	// Fake pools returning different versions for the same query
	const poolA: any = { name: 'connA', async query() { return [{ version: 'SQL-A' }]; }, async close() {} };
	const poolB: any = { name: 'connB', async query() { return [{ version: 'SQL-B' }]; }, async close() {} };

	const a1 = await MssqlTools.handleGetVersion(poolA);
	const b1 = await MssqlTools.handleGetVersion(poolB);
	const aText = a1.content[0].text;
	const bText = b1.content[0].text;
	check('poolA returns its own version', aText.includes('SQL-A'), true);
	check('poolB is NOT served poolA cache', bText.includes('SQL-B'), true);
	check('poolB did not get SQL-A', bText.includes('SQL-A'), false);
}
```

(Dosyanın en üstündeki test çalıştırma bir async IIFE değilse, `await` kullanımı için testin ana gövdesini `(async () => { ... })()` içine almak gerekebilir. Eğer mevcut test dosyası top-level await desteklemiyorsa, bu bloğu ve pass/fail özetini bir `async` IIFE'ye taşı. ts-node ESM loader top-level await'i destekler — önce düz `await` ile dene; TS hatası verirse IIFE'ye sar.)

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu gör**

Run: `node --loader ts-node/esm src/tests/multi-connection.test.ts`
Expected: FAIL — `poolB did not get SQL-A` başarısız (statik `versionCache` poolA'nın sürümünü poolB'ye servis eder).

- [ ] **Step 3: `MssqlTools.ts` — versionCache'i Map yap ve tüm anahtarları namespace'le**

Import ekle:

```typescript
import { namespaceCacheKey } from './utils/identifier.js';
```

`versionCache` tanımını değiştir (satır ~58):

```typescript
// Static per-connection cache for SQL Server version (never changes during runtime)
const versionCache = new Map<string, string>();
```

`handleGetVersion(pool)` içini güncelle — `versionCache !== null` mantığını Map'e çevir:

```typescript
	async handleGetVersion(pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		const cached = versionCache.get(pool.name);
		if (cached !== undefined) {
			if (consola.level >= 0) {
				logger.debug('Returning cached SQL Server version');
			}
			return { content: [{ type: 'text', text: cached + '\n\n📋 (Cached result)' }] };
		}

		try {
			const results = await pool.query('SELECT @@VERSION AS version');
			const version = results[0]?.version || 'Unknown';
			versionCache.set(pool.name, version);
			if (consola.level >= 0) {
				logger.info('SQL Server version cached');
			}
			return { content: [{ type: 'text', text: version }] };
		} catch (error) {
			if (consola.level >= 0) {
				logger.error('Error getting SQL Server version:', error);
			}
			return { content: [{ type: 'text', text: `Error getting version: ${error instanceof Error ? error.message : 'Unknown error'}` }] };
		}
	},
```

`MssqlTools.ts` içindeki **diğer tüm** cache anahtarı kullanımını namespace'le. Aşağıdaki her handler'da, `const cacheKey = <ifade>;` satırından hemen sonra anahtarı sar. Etkilenen handler'lar ve ham anahtarları:

- `handleListTables`: `const cacheKey = schemaFilter || '_all_schemas_';` → sonra `const nsCacheKey = namespaceCacheKey(pool.name, cacheKey);` ve bu handler'daki `listTablesCache` get/set çağrılarında `cacheKey` yerine `nsCacheKey` kullan (getFromToolCache ve `listTablesCache.set`).
- `handleGetTableSchema`: `const cacheKey = \`${schemaName}:${tableName}\`;` → `nsCacheKey = namespaceCacheKey(pool.name, cacheKey)`; `tableSchemaCache` get/set'te kullan.
- `handleGetForeignKeys`: mevcut cache anahtarını bul, aynı kalıpla `foreignKeysCache` için namespace'le.
- `handleSearchColumns`: `columnsCache` anahtarını namespace'le.
- `handleGetTableRelationships`: `relationshipsCache` anahtarını namespace'le.
- `handleGetTableIndexes`: `indexesCache` anahtarını namespace'le.
- `handleExecuteSql`: sorgu cache anahtarını namespace'le — `getCacheKey(query)` sonucunu `namespaceCacheKey(pool.name, getCacheKey(query))` ile sar; `queryCache` get/set ve `cleanExpiredEntry`/`enforceCacheSizeLimit` çağrılarında bu namespace'li anahtarı kullan.

Her handler'da hem **okuma** (getFromToolCache/getFromCache/queryCache.get) hem **yazma** (`.set(...)`) tarafında namespace'li anahtarın kullanıldığından emin ol.

- [ ] **Step 4: `MssqlServerTools.ts` — 4 cache'i namespace'le**

Import ekle: `import { namespaceCacheKey } from './utils/identifier.js';`

Her handler zaten `pool`'a erişiyor. `getFromCache`/`setInCache` çağrılarında kullanılan anahtarları namespace'le:
- `handleListDatabases`: `databasesCache` anahtarı → `namespaceCacheKey(pool.name, <mevcut anahtar, örn. include_system bayrağı>)`.
- `handleListSchemas`: `schemasCache` anahtarı (mevcutta `buildCacheKeyPrefix(database_name)` tabanlı) → `namespaceCacheKey(pool.name, <mevcut anahtar>)`.
- `handleListLinkedServers`: `linkedServersCache` anahtarı → namespace'le.
- `handleGetServerInfo`: `serverInfoCache` anahtarı → namespace'le.

(Not: `handleListLinkedServers(pool)` ve `handleGetServerInfo(pool)` `args` almıyor ama `pool` var — `pool.name`'e erişebilirler.)

- [ ] **Step 5: `MssqlObjectTools.ts` ve `MssqlProfilingTools.ts` — cache'leri namespace'le**

Her iki dosyaya import ekle: `import { namespaceCacheKey } from './utils/identifier.js';`

`MssqlObjectTools.ts` — 4 handler'ın (list_stored_procedures, list_views, list_functions, list_triggers) cache get/set anahtarlarını `namespaceCacheKey(pool.name, <mevcut anahtar>)` ile sar.

`MssqlProfilingTools.ts` — `profile_column` ve `get_table_row_count` handler'larının cache anahtarlarını namespace'le. (`get_table_sample` zaten cache'lenmiyor — dokunma.)

- [ ] **Step 6: Testi çalıştır, geçtiğini gör**

Run: `node --loader ts-node/esm src/tests/multi-connection.test.ts`
Expected: PASS — cache isolation bloğu dahil hepsi ✅.

- [ ] **Step 7: Mevcut tüm testleri ve derlemeyi çalıştır**

Run: `npx tsc --noEmit && npm test`
Expected: tsc temiz; tüm test paketleri geçer.

- [ ] **Step 8: Commit**

```bash
git add src/MssqlTools.ts src/MssqlServerTools.ts src/MssqlObjectTools.ts src/MssqlProfilingTools.ts src/tests/multi-connection.test.ts
git commit -m "feat: namespace all tool caches by connection name"
```

---

### Task 6: `list_connections` aracı

**Files:**
- Modify: `src/MssqlServerTools.ts`
- Test: `src/tests/multi-connection.test.ts`

**Interfaces:**
- Consumes: `ConnectionRegistry.list()` (Task 4), `formatCSV`
- Produces:
  - `MssqlServerTools.LIST_CONNECTIONS_TOOL` tanımı (getToolDefinitions'a eklenir).
  - `MssqlServerTools.handleListConnections(registry: ConnectionRegistry): { content: TextContent[] }` — CSV döndürür.
  - `list_connections` **canHandle'a dahil edilmez** (server özel yolla çağırır — Task 7).

- [ ] **Step 1: Testi yaz** (multi-connection.test.ts'e ekle)

```typescript
import { MssqlServerTools } from '../MssqlServerTools.js';

console.log('\n--- list_connections tool ---');
{
	const parsed = parseConnectionConfigs({
		MSSQL_CONNECTIONS: JSON.stringify({
			default: 'uretim',
			connections: {
				uretim: { server: 'prod', database: 'S', user: 'u', password: 'secret-pw' },
				test: { server: 'test', database: 'S', user: 'v', password: 'secret-pw' },
			},
		}),
	} as any);
	const registry = new ConnectionRegistry(parsed);
	const res = MssqlServerTools.handleListConnections(registry);
	const text = res.content[0].text;
	check('lists uretim', text.includes('uretim'), true);
	check('lists test', text.includes('test'), true);
	check('shows server', text.includes('prod'), true);
	check('NEVER leaks password', text.includes('secret-pw'), false);

	// Tool is advertised but NOT routed through the pool path
	const defs = MssqlServerTools.getToolDefinitions();
	check('list_connections advertised', defs.some((d) => d.name === 'list_connections'), true);
	check('list_connections excluded from canHandle', MssqlServerTools.canHandle('list_connections'), false);
}
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu gör**

Run: `node --loader ts-node/esm src/tests/multi-connection.test.ts`
Expected: FAIL — `handleListConnections` yok.

- [ ] **Step 3: Aracı ekle**

`src/MssqlServerTools.ts` başına import ekle:

```typescript
import type { ConnectionRegistry } from './server/ConnectionRegistry.js';
```

`getToolDefinitions()` dizisine yeni girdi ekle (diğer 4'ün yanına). Bu araç `connection_name` **almaz** (registry-geneli), bu yüzden `ConnectionScopeSchema` ile genişletilMEZ:

```typescript
{
	name: 'list_connections',
	description: 'List all configured database connections available to this MCP server: name, server, database, user, and which one is the default. Use the returned name as the connection_name parameter on other tools to target a specific connection. Passwords are never exposed.',
	inputSchema: z.toJSONSchema(z.object({})) as any,
},
```

`canHandle` **değişmez** — `TOOL_NAMES` setine `list_connections` EKLENMEZ (server özel yolla çağırır).

`MssqlServerTools` nesnesine yeni metod ekle:

```typescript
handleListConnections(registry: ConnectionRegistry): { content: TextContent[] } {
	const rows = registry.list().map((c) => ({
		name: c.name,
		server: c.server,
		database: c.database,
		user: c.user,
		is_default: c.is_default ? 'yes' : 'no',
	}));
	if (rows.length === 0) {
		return plainResponse('No connections configured.');
	}
	return plainResponse(formatCSV(rows));
},
```

- [ ] **Step 4: Testi çalıştır, geçtiğini gör**

Run: `node --loader ts-node/esm src/tests/multi-connection.test.ts`
Expected: PASS — list_connections satırları ✅.

- [ ] **Step 5: Derleme kontrolü**

Run: `npx tsc --noEmit`
Expected: Hata yok.

- [ ] **Step 6: Commit**

```bash
git add src/MssqlServerTools.ts src/tests/multi-connection.test.ts
git commit -m "feat: add list_connections tool"
```

---

### Task 7: `MssqlMcpServer` bağlantısı — registry yönlendirme, resources, health, stop

**Files:**
- Modify: `src/server/MssqlMcpServer.ts`
- Test: build + smoke (aşağıda)

**Interfaces:**
- Consumes: `ConnectionRegistry`, `resolvePoolForCall` (Task 4), `parseConnectionConfigs` (Task 3), `MssqlServerTools.handleListConnections` (Task 6)

- [ ] **Step 1: Import'ları güncelle**

`src/server/MssqlMcpServer.ts` başında:

```typescript
import { ConnectionRegistry, resolvePoolForCall } from './ConnectionRegistry.js';
import { parseConnectionConfigs } from './config';
```

`createResilientConnectionPool, ResilientConnectionPool` importunu kaldır (artık registry kullanılıyor); `ResilientConnectionPool` tipine hâlâ ihtiyaç yoksa sil.

- [ ] **Step 2: Alanı değiştir**

```typescript
	private registry?: ConnectionRegistry;
```

(`private pool?: ResilientConnectionPool;` satırını sil.)

- [ ] **Step 3: `CallToolRequestSchema` handler'ını güncelle**

`setupHandlers()` içindeki tool handler'ını şununla değiştir:

```typescript
		this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
			if (this.configError) {
				return {
					content: [{ type: 'text' as const, text: `Error: Database configuration failed: ${this.configError}` }],
					isError: true,
				};
			}
			if (!this.registry) {
				return {
					content: [{ type: 'text' as const, text: 'Error: Database connection is not yet initialized. Please try again shortly.' }],
					isError: true,
				};
			}

			const { name, arguments: args } = request.params;

			// list_connections is registry-wide — no pool resolution.
			if (name === 'list_connections') {
				return MssqlServerTools.handleListConnections(this.registry);
			}

			// Resolve the target pool from connection_name (default when omitted).
			let pool;
			try {
				pool = resolvePoolForCall(this.registry, args);
			} catch (error) {
				return {
					content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'connection resolution failed'}` }],
					isError: true,
				};
			}

			if (MssqlObjectTools.canHandle(name)) {
				return await MssqlObjectTools.handleTool(name, args, pool);
			}
			if (MssqlServerTools.canHandle(name)) {
				return await MssqlServerTools.handleTool(name, args, pool);
			}
			if (MssqlProfilingTools.canHandle(name)) {
				return await MssqlProfilingTools.handleTool(name, args, pool);
			}
			return await MssqlTools.handleTool(name, args, pool);
		});
```

- [ ] **Step 4: Resource handler'larını registry'ye çevir**

`ListResourcesRequestSchema` ve `ReadResourceRequestSchema` handler'larında `this.pool` yerine `this.registry?.get()` (varsayılan bağlantı) kullan:

```typescript
		this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
			if (!this.registry) {
				return { resources: [] };
			}
			const resources = await MssqlResources.getResourceDefinitions(this.registry.get());
			return { resources };
		});

		this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
			if (!this.registry) {
				throw new Error('Database connection is not yet initialized. Please try again shortly.');
			}
			const { uri } = request.params;
			const contents = await MssqlResources.handleResource(uri, this.registry.get());
			return { contents: [contents] };
		});
```

- [ ] **Step 5: `/health` uç noktasını per-connection yap**

`this.app.get('/health', ...)` içini güncelle:

```typescript
			this.app.get('/health', (c) => {
				const connections = this.registry
					? this.registry.list().map((info) => ({
						name: info.name,
						connected: this.registry!.get(info.name).isConnected,
					}))
					: [];
				const defaultConnected = this.registry ? this.registry.get().isConnected : false;
				return c.json({
					status: 'healthy',
					database: defaultConnected ? 'connected' : 'disconnected',
					connections,
					timestamp: new Date().toISOString(),
					service: 'mssql-mcp-server',
					version: '1.0.0',
				});
			});
```

- [ ] **Step 6: `initializeDatabase`'i registry kuracak şekilde güncelle**

Metodu şununla değiştir (config → parseConnectionConfigs; registry; **eager connect YOK** — tembel):

```typescript
	private initializeDatabase(fileLogger: ReturnType<typeof getFileLogger>): void {
		fileLogger.info('Parsing connection configuration...');
		let parsed;
		try {
			parsed = parseConnectionConfigs();
			fileLogger.info('Connection configuration parsed', {
				defaultConnection: parsed.defaultName,
				connectionCount: parsed.connections.size,
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this.configError = errorMsg;
			fileLogger.error('Failed to parse connection configuration', error);
			if (!this.config.stdio) {
				serverLogger.error(`Database configuration failed: ${errorMsg}`);
			}
			return;
		}

		try {
			this.registry = new ConnectionRegistry(parsed);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this.configError = errorMsg;
			fileLogger.error('Failed to create connection registry', error);
			if (!this.config.stdio) {
				serverLogger.error(`Failed to create connection registry: ${errorMsg}`);
			}
			return;
		}

		// Lazy connections: pools connect on first use. No eager connect here.
		fileLogger.info('Connection registry ready (lazy connections)');
	}
```

- [ ] **Step 7: `stop()`'u registry'ye çevir**

`stop()` içindeki `if (this.pool) { await this.pool.close(); ... }` bloğunu şununla değiştir:

```typescript
		if (this.registry) {
			await this.registry.closeAll();
			if (!this.config.stdio) {
				serverLogger.info('All database connection pools closed');
			}
		}
```

- [ ] **Step 8: Derle ve mevcut testleri çalıştır**

Run: `npx tsc --noEmit && npm test`
Expected: tsc temiz; tüm testler geçer.

- [ ] **Step 9: Bundle derle (smoke)**

Run: `npm run build`
Expected: `dist/main.mjs` üretilir, bundle boyut raporu yazılır, hata yok.

- [ ] **Step 10: STDIO başlatma smoke testi (çoklu bağlantı, DB'siz)**

Sunucunun çoklu-bağlantı config'iyle çökmeden ayağa kalktığını doğrula (gerçek DB gerekmez — tembel bağlanma). Erişilemez sunucularla bile transport ayağa kalkmalı:

```bash
MSSQL_CONNECTIONS='{"default":"a","connections":{"a":{"server":"localhost","database":"x","user":"u","password":"p"},"b":{"server":"unreachable-host","database":"x","user":"u","password":"p"}}}' timeout 3 node dist/main.mjs --stdio; echo "exit: $?"
```

Expected: Süreç 3 saniye boyunca ayakta kalır (timeout ile 124 ile sonlanır), config/parse hatası vermez, çökme yok. (`exit: 124` beklenir — timeout kesti, yani süreç sağlıklı çalışıyordu.)

- [ ] **Step 11: Commit**

```bash
git add src/server/MssqlMcpServer.ts dist/main.mjs
git commit -m "feat: wire ConnectionRegistry into MCP server routing"
```

---

### Task 8: Dokümantasyon

**Files:**
- Modify: `CLAUDE.md`, `README.md` (varsa; yoksa atla), `~/.claude/rules/mssql-mcp.md`

**Interfaces:** yok (dokümantasyon)

- [ ] **Step 1: CLAUDE.md — çoklu bağlantı bölümü ekle**

`CLAUDE.md` içinde "Environment Variables" bölümüne yeni alt bölüm ekle:

```markdown
### Multi-Connection Support

The server supports multiple named connections via a single `MSSQL_CONNECTIONS` env var (JSON), set directly in `.mcp.json`:

```json
"env": {
  "MSSQL_CONNECTIONS": "{\"default\":\"uretim\",\"connections\":{\"uretim\":{\"server\":\"prod-sql\",\"database\":\"Sales\",\"user\":\"ro\",\"password\":\"***\"},\"test\":{\"server\":\"test-sql\",\"database\":\"Sales\",\"user\":\"ro\",\"password\":\"***\"}}}"
}
```

- **Backward compatible**: if `MSSQL_CONNECTIONS` is absent, the legacy `MSSQL_SERVER`/`MSSQL_USER`/... vars define a single connection named `default`. When `MSSQL_CONNECTIONS` IS present, the legacy vars are ignored.
- **Default resolution**: single connection → auto-default; multiple connections require an explicit `default`; a `default` pointing to a missing name is a config error.
- **Connection selection**: every tool accepts an optional `connection_name` parameter (omit → default). Use `list_connections` to discover names (never exposes passwords).
- **Cache isolation**: all tool caches are namespaced by connection name — results never bleed across connections.
- **Lazy connections**: each pool connects on first use (VPN-friendly).
- **Resources** (`mssql://{table}/data`) operate on the **default connection only**; use tools with `connection_name` for other connections.
```

Ayrıca "Tools Layer" açıklamasında araç sayısını ve `list_connections`'ı belgele (Server Tools Layer'a `list_connections` ekle).

- [ ] **Step 2: README.md güncelle** (dosya varsa)

Run: `ls README.md 2>/dev/null && echo "var" || echo "yok"`

Varsa: `.mcp.json` örneklerine çoklu-bağlantı örneği + geriye uyum notu ekle. Yoksa bu adımı atla.

- [ ] **Step 3: ~/.claude/rules/mssql-mcp.md güncelle**

Kurallar dosyasında araç sayısını (19→20) güncelle ve "Discovery" bölümünün başına ekle:

```markdown
0. `list_connections()` → configured connections (name, server, database, default). Use the `name` as `connection_name` on any tool to target a specific server. Omit `connection_name` to use the default connection.
```

Ve "Rules" bölümüne ekle:

```markdown
- **Multiple connections**: pass `connection_name` to target a non-default server; call `list_connections` first to see available names
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md ~/.claude/rules/mssql-mcp.md
git commit -m "docs: document multi-connection support"
```

(README.md değiştiyse onu da ekle.)

---

## Self-Review Notları

**Spec kapsamı:** Spec'teki D1–D20 kararlarının tümü görevlere eşlendi — D1/D2 (Task 3 parseConnectionConfigs), D3 tembel (Task 4 registry + Task 7 no-eager-connect), D4/D18 önbellek namespace (Task 1 helper + Task 5 uygulama), D5 (Task 4 resolvePoolForCall), D6/D7 (Task 2 schema merge + Task 7 routing), D8 (Task 6 list_connections), D9 sır (Task 4 list() + Task 6 test), D12 (Task 3), D13 (Task 4), D14 versionCache (Task 5), D15 configError (Task 7 initializeDatabase), D16 resources (Task 7 Step 4), D17 health (Task 7 Step 5), D19 testler (her görevde), D20 docs (Task 8).

**Tip tutarlılığı:** `ConnectionPool.name`, `ResilientConnectionPool.name`, `ConnectionRegistry.get()/list()/has()/closeAll()/defaultName`, `resolvePoolForCall`, `parseConnectionConfigs`, `ParsedConnections`, `ConnectionInfo`, `namespaceCacheKey`, `validateConnectionName`, `ConnectionScopeSchema`, `handleListConnections` — görevler arası imzalar tutarlı.

**Bilinen incelik:** Task 5 testinde top-level `await` gerekiyor; ts-node ESM loader destekler, aksi halde async IIFE'ye sarılacağı not düşüldü.
