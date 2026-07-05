# Performance & Operations Tools (Paket B+C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 3 performance-diagnostic tools (get_missing_indexes, get_query_plan, get_top_queries) and 4 operational improvements (query timeout, clear_cache tool, resources multi-connection, token efficiency) to the read-only MSSQL MCP server — tool count 23 → 27.

**Architecture:** New provider layer `src/MssqlPerformanceTools.ts` follows the existing canHandle/getToolDefinitions/handleTool pattern; server routing chain gains one branch. Operational items are embedded where they live: timeout in config.ts+connection.ts, token efficiency in csv.ts+MssqlTools, clear_cache in MssqlServerTools (calling `clearCaches()` exports of every layer), multi-connection resources in MssqlResources.

**Tech Stack:** TypeScript ESM, mssql (node driver), Zod v4, MCP SDK, framework-less test scripts via ts-node ESM loader.

**Spec:** docs/superpowers/specs/2026-07-05-perf-ops-tools-design.md

**Branch:** create `feat/perf-ops-tools` from `main` before Task 1 Step 1:
```bash
git checkout -b feat/perf-ops-tools
```

## Global Constraints

- Server stays **READ-ONLY by design**. `clear_cache` executes **no SQL at all**. `get_query_plan` runs the candidate query through `isReadOnlyQuery()` BEFORE any connection is opened; blocked keywords (`UNION`, `EXEC`, …) are rejected for planning too (documented in the tool description).
- User text reaches SQL only as quote-doubled literals (`escapeLiteral`), LIKE-escaped literals (`escapeLikePattern` + `ESCAPE '\'`), validated identifiers (`validateObjectName` / `validateDatabaseName` / `parseObjectName`), or values from enum-keyed lookup maps.
- All string literals carrying user text are **N-prefixed** (`N'...'`).
- **Never** use `OBJECT_ID('db.schema.obj')` with interpolated multi-part names (dotted DB names return NULL silently). Missing-index table filter uses the DMV `statement` column with a LIKE suffix match instead.
- Single-line SQL template literals; TAB indentation; `if (consola.level >= 0)` log guards; conventional commits.
- Cache keys namespaced per connection via `namespaceCacheKey(pool.name, rawKey)` (format: `` `${connectionName}::${rawKey}` ``); new caches use the lazy-TTL + true-LRU pattern copied from MssqlServerTools.
- `dist/main.mjs` is a committed deployed artifact: rebuild via `npm run build` only in Task 7; never hand-edit.
- Backward compatibility: existing tool calls, env configs, and single-connection resource URIs keep working unchanged. `ConnectionPool.query` gains only an OPTIONAL second parameter.
- Driver timeout interplay: driver `requestTimeout` = `Math.max(300000, config.requestTimeout ?? 0)` (backstop only); the EFFECTIVE timeout is always enforced by the cancel-timer in `ResilientConnectionPool.query()` (`options?.timeoutMs ?? config.requestTimeout ?? 30000`). Timeout errors must be detected via a local `timedOut` flag BEFORE `isConnectionError` so a cancel never triggers reconnect.
- Tests: framework-less scripts with `check`/`checkContains` helpers and fake pools (`{ name, query: async (sql) => ... }`); every test file ends with a pass/fail summary and `process.exit(1)` on failure.

## File Structure

| File | Change |
|---|---|
| `src/server/config.ts` | `requestTimeout` in MssqlConfig + 3 parsing sources (Task 1) |
| `src/server/connection.ts` | QueryOptions + cancel-timer (Task 1); EphemeralConnection (Task 4) |
| `src/MssqlTools.ts` | `timeout_seconds` (Task 1); `max_rows` + cell truncation + cache key (Task 2); `clearCaches` (Task 5) |
| `src/utils/csv.ts` | `formatCSV` third param `maxCellChars` (Task 2) |
| `src/MssqlProfilingTools.ts` | sample truncation (Task 2); `clearCaches` (Task 5) |
| `src/MssqlPerformanceTools.ts` | NEW: 2 tools (Task 3) + get_query_plan (Task 4) + `clearCaches` (Task 5) |
| `src/server/MssqlMcpServer.ts` | performance routing (Task 3); resources registry pass (Task 6) |
| `src/utils/cacheClear.ts` | NEW: shared `clearMapByPrefix` (Task 5) |
| `src/MssqlServerTools.ts` | `clear_cache` tool + `clearCaches` (Task 5) |
| `src/MssqlObjectTools.ts` | `clearCaches` (Task 5) |
| `src/MssqlResources.ts` | `clearCaches` (Task 5); multi-connection rewrite (Task 6) |
| `src/tests/operations.test.ts` | NEW (Task 1), extended (Tasks 2, 5, 6) |
| `src/tests/performance-tools.test.ts` | NEW (Task 3), extended (Task 4) |
| `src/tests/multi-connection.test.ts` | tool count 23→25 (T3) →26 (T4) →27 (T5) |
| `package.json` | test scripts (Tasks 1, 3) |
| `CLAUDE.md`, `README.md` | docs (Task 7) |

---

### Task 1: Query timeout (env + per-call `timeout_seconds`)

**Files:**
- Modify: `src/server/config.ts` (MssqlConfig interface ~line 4; getMssqlConfig after port block ~line 68; RawConnectionEntry ~line 225; CONN_FIELD_MAP ~line 247; collectPrefixedConnections coercion ~line 308; buildConnections ~line 330)
- Modify: `src/server/connection.ts` (interface ~line 8; buildMssqlConfig ~line 21; ResilientConnectionPool.query ~line 298; legacy createConnectionPool query ~line 434)
- Modify: `src/MssqlTools.ts` (ExecuteSqlInputSchema ~line 162; handleExecuteSql ~line 974)
- Create: `src/tests/operations.test.ts`
- Modify: `package.json` (test chain + `test:operations` script)

**Interfaces:**
- Consumes: existing `MssqlConfig`, `ResilientConnectionPool`, `MssqlTools.handleTool`.
- Produces: `MssqlConfig.requestTimeout?: number` (ms); `export interface QueryOptions { timeoutMs?: number }` in connection.ts; `ConnectionPool.query<T>(sqlQuery: string, options?: QueryOptions)`. Later tasks rely on the `options` param existing but never on its behavior.

- [ ] **Step 1: Write the failing test — create `src/tests/operations.test.ts`**

```ts
/**
 * Tests for operational features: query timeout, token efficiency,
 * clear_cache, and multi-connection resources (no DB connection required).
 * Run with: npm run test:operations
 */

import { getMssqlConfig, parseConnectionConfigs } from '../server/config.js';
import { ResilientConnectionPool } from '../server/connection.js';
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
		console.error(`❌ ${name} — expected to contain "${needle}", got: ${haystack.substring(0, 200)}`);
	}
}

console.log('\n--- requestTimeout config parsing ---');
{
	const baseEnv = { MSSQL_SERVER: 's', MSSQL_DATABASE: 'd', MSSQL_USER: 'u', MSSQL_PASSWORD: 'p' };
	const cfg = getMssqlConfig({ ...baseEnv, MSSQL_REQUEST_TIMEOUT: '45000' } as any);
	check('MSSQL_REQUEST_TIMEOUT parsed (ms)', cfg.requestTimeout, 45000);

	const cfg2 = getMssqlConfig({ ...baseEnv, MSSQL_REQUEST_TIMEOUT: 'abc' } as any);
	check('invalid MSSQL_REQUEST_TIMEOUT ignored', cfg2.requestTimeout, undefined);

	const flatEnv: any = {
		MSSQL_CONN_prod_SERVER: 'ps',
		MSSQL_CONN_prod_DATABASE: 'pd',
		MSSQL_CONN_prod_USER: 'pu',
		MSSQL_CONN_prod_PASSWORD: 'pp',
		MSSQL_CONN_prod_REQUEST_TIMEOUT: '60000',
	};
	const parsed = parseConnectionConfigs(flatEnv);
	check('flat MSSQL_CONN_<name>_REQUEST_TIMEOUT parsed', parsed.connections.get('prod')?.requestTimeout, 60000);

	const flatNoTimeout: any = {
		MSSQL_CONN_prod_SERVER: 'ps',
		MSSQL_CONN_prod_DATABASE: 'pd',
		MSSQL_CONN_prod_USER: 'pu',
		MSSQL_CONN_prod_PASSWORD: 'pp',
		MSSQL_REQUEST_TIMEOUT: '45000',
	};
	const parsed2 = parseConnectionConfigs(flatNoTimeout);
	check('global MSSQL_REQUEST_TIMEOUT is per-connection fallback', parsed2.connections.get('prod')?.requestTimeout, 45000);

	const jsonEnv: any = {
		MSSQL_CONNECTIONS: JSON.stringify({ connections: { j: { server: 'js', database: 'jd', user: 'ju', password: 'jp', requestTimeout: 70000 } } }),
	};
	const parsed3 = parseConnectionConfigs(jsonEnv);
	check('JSON blob requestTimeout parsed', parsed3.connections.get('j')?.requestTimeout, 70000);
}

console.log('\n--- cancel-timer timeout enforcement ---');
{
	const dummyConfig: any = { server: 'x', database: 'd', user: 'u', password: 'p', port: 1433, encrypt: false, command: 'execute_sql', windowsAuth: false, requestTimeout: 30000 };
	const rp = new ResilientConnectionPool(dummyConfig, 'timeout-test');

	let cancelCalled = false;
	let rejectFn: (e: Error) => void = () => {};
	const hangingRequest = {
		query: () => new Promise((_res, rej) => { rejectFn = rej; }),
		cancel: () => { cancelCalled = true; rejectFn(new Error('Canceled.')); },
	};
	(rp as any).pool = { request: () => hangingRequest, close: async () => {} };
	(rp as any).connected = true;

	let threw = false;
	try {
		await rp.query('SELECT 1', { timeoutMs: 50 });
	} catch (e) {
		threw = true;
		checkContains('timeout error message', (e as Error).message, 'timeout and was cancelled');
	}
	check('timed-out query throws', threw, true);
	check('request.cancel() was invoked', cancelCalled, true);
	check('cancel NOT classified as connection loss (still connected)', rp.isConnected, true);

	// fast success path: timer must not fire / cancel must not be called
	let fastCancel = false;
	const fastRequest = {
		query: async () => ({ recordset: [{ a: 1 }] }),
		cancel: () => { fastCancel = true; },
	};
	(rp as any).pool = { request: () => fastRequest, close: async () => {} };
	const rows = await rp.query('SELECT 2', { timeoutMs: 5000 });
	check('fast query returns rows', rows.length, 1);
	check('fast query never cancelled', fastCancel, false);
	await rp.close();
}

console.log('\n--- exec_sql_csv timeout_seconds threading ---');
{
	let capturedOptions: any = 'unset';
	const fakePool: any = { name: 'opsA', query: async (_sql: string, options?: any) => { capturedOptions = options; return [{ x: 1 }]; } };

	await MssqlTools.handleTool('exec_sql_csv', { query: 'SELECT 1 AS one', timeout_seconds: 120 }, fakePool);
	check('timeout_seconds=120 → timeoutMs=120000', capturedOptions?.timeoutMs, 120000);

	capturedOptions = 'unset';
	await MssqlTools.handleTool('exec_sql_csv', { query: 'SELECT 2 AS two' }, fakePool);
	check('no timeout_seconds → options undefined', capturedOptions, undefined);

	const bad = await MssqlTools.handleTool('exec_sql_csv', { query: 'SELECT 3 AS three', timeout_seconds: 500 }, fakePool);
	checkContains('timeout_seconds > 300 rejected by Zod', bad.content[0].text as string, 'Invalid arguments');
}

// --- summary (KEEP LAST — later tasks append sections ABOVE this block) ---
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Add `test:operations` script to `package.json`** — append `src/tests/operations.test.ts` to the END of the `"test"` chain and add:

```json
"test:operations": "node --loader ts-node/esm src/tests/operations.test.ts"
```

(The `"test"` value becomes `"... && node --loader ts-node/esm src/tests/schema-description.test.ts && node --loader ts-node/esm src/tests/operations.test.ts"`.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:operations`
Expected: FAIL — `cfg.requestTimeout` is `undefined` (property doesn't exist yet), timeout error message missing.

- [ ] **Step 4: Implement config.ts changes**

4a. `MssqlConfig` interface gains a field (after `windowsAuth: boolean;`):

```ts
	/** Effective query timeout in milliseconds (default 30000). Per-call override via exec_sql_csv timeout_seconds. */
	requestTimeout?: number;
```

4b. In `getMssqlConfig`, after the `MSSQL_PORT` block (after line ~68):

```ts
	// Query timeout support (milliseconds, consistent with all other duration env vars)
	const requestTimeoutRaw = env.MSSQL_REQUEST_TIMEOUT;
	if (requestTimeoutRaw) {
		const parsedTimeout = parseInt(requestTimeoutRaw, 10);
		if (!Number.isNaN(parsedTimeout) && parsedTimeout > 0) {
			config.requestTimeout = parsedTimeout;
		} else if (consola.level >= 0) {
			logger.warn(`Invalid MSSQL_REQUEST_TIMEOUT value: ${requestTimeoutRaw}. Using default 30000ms.`);
		}
	}
```

4c. `RawConnectionEntry` gains `requestTimeout?: number;`

4d. `CONN_FIELD_MAP` gains `REQUEST_TIMEOUT: 'requestTimeout',` (the existing longest-suffix-first sort handles the two-token suffix automatically).

4e. In `collectPrefixedConnections`, extend the coercion chain (before the final `else`):

```ts
			} else if (field === 'requestTimeout') {
				const t = parseInt(value, 10);
				if (!Number.isNaN(t) && t > 0) entry.requestTimeout = t;
```

4f. In `buildConnections`, before the `for` loop compute the global fallback, and add the field to the config literal:

```ts
	const globalTimeoutRaw = env.MSSQL_REQUEST_TIMEOUT ? parseInt(env.MSSQL_REQUEST_TIMEOUT, 10) : NaN;
	const globalTimeout = !Number.isNaN(globalTimeoutRaw) && globalTimeoutRaw > 0 ? globalTimeoutRaw : undefined;
```

and inside `normalizeMssqlConfig({ ... })`:

```ts
			requestTimeout: (typeof entry.requestTimeout === 'number' && entry.requestTimeout > 0 ? entry.requestTimeout : undefined) ?? globalTimeout,
```

(`normalizeMssqlConfig` spreads `raw`, so the field passes through untouched.)

- [ ] **Step 5: Implement connection.ts changes**

5a. Add after the imports:

```ts
// Driver-level requestTimeout is pool-wide, so it is only a BACKSTOP set high
// enough that per-call increases (up to 300 s) can work. The EFFECTIVE timeout
// is always enforced by the cancel-timer in ResilientConnectionPool.query().
const DRIVER_TIMEOUT_FLOOR_MS = 300000;
const DEFAULT_EFFECTIVE_TIMEOUT_MS = 30000;

export interface QueryOptions {
	/** Per-call timeout in milliseconds; overrides the connection's configured requestTimeout. */
	timeoutMs?: number;
}
```

5b. `ConnectionPool` interface: change the query signature to

```ts
	query<T = any>(sqlQuery: string, options?: QueryOptions): Promise<T[]>;
```

5c. In `buildMssqlConfig`, add to the `mssqlConfig` literal (after `port: config.port,`):

```ts
		requestTimeout: Math.max(DRIVER_TIMEOUT_FLOOR_MS, config.requestTimeout ?? 0),
```

5d. Rewrite `ResilientConnectionPool.query` — replace the body from `fileLogger.debug('Executing query', ...)` to the end of the method with:

```ts
		fileLogger.debug('Executing query', { query: sqlQuery.substring(0, 200) });
		const effectiveTimeoutMs = options?.timeoutMs ?? this.localConfig.requestTimeout ?? DEFAULT_EFFECTIVE_TIMEOUT_MS;
		const request = pool.request();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try { request.cancel(); } catch { /* cancel is best-effort */ }
		}, effectiveTimeoutMs);
		try {
			const result = await request.query(sqlQuery);
			if (consola.level >= 0) {
				logger.debug('Read-only query executed successfully');
			}
			fileLogger.debug('Query executed successfully', {
				rowCount: result.recordset?.length || 0,
			});
			return result.recordset as T[];
		} catch (error) {
			// FIRST: our own cancellation — must never be classified as connection loss
			if (timedOut) {
				fileLogger.warn('Query cancelled by effective timeout', { effectiveTimeoutMs });
				throw new Error(
					`Query exceeded the ${Math.round(effectiveTimeoutMs / 1000)}-second timeout and was cancelled. Use timeout_seconds to allow more time (max 300).`,
				);
			}
			// If this is a connection error, mark as disconnected and start retry
			if (isConnectionError(error)) {
				fileLogger.error('Connection lost during query execution, starting background retry');
				this.connected = false;
				if (!this.stopped) {
					this.retryDelay = 1000; // Reset backoff for fresh disconnect
					this.scheduleBackgroundRetry();
				}
				throw new Error(
					'Database connection was lost during query execution. The server will automatically reconnect when the database becomes available.',
				);
			}

			// For non-connection errors, use the shared error classifier
			return handleQueryError(error, sqlQuery);
		} finally {
			clearTimeout(timer);
		}
```

and change the method signature to `async query<T = any>(sqlQuery: string, options?: QueryOptions): Promise<T[]> {`.

5e. Legacy `createConnectionPool` returned object: change its query signature to `async query<T = any>(sqlQuery: string, _options?: QueryOptions): Promise<T[]> {` (options intentionally ignored on the deprecated path).

- [ ] **Step 6: Implement MssqlTools changes**

6a. `ExecuteSqlInputSchema` gains:

```ts
	timeout_seconds: z.number().int().min(1).max(300).optional().describe('Per-call query timeout in seconds (1-300). Overrides the MSSQL_REQUEST_TIMEOUT default (30 seconds) for this query only.'),
```

6b. In `handleExecuteSql`, change `let results = await pool.query(query);` to:

```ts
				let results = await pool.query(query, validatedArgs.timeout_seconds ? { timeoutMs: validatedArgs.timeout_seconds * 1000 } : undefined);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test:operations` → all Task 1 checks PASS.
Run: `npm test` → all suites green (no regressions).

- [ ] **Step 8: Commit**

```bash
git add src/server/config.ts src/server/connection.ts src/MssqlTools.ts src/tests/operations.test.ts package.json
git commit -m "feat(timeout): effective query timeout via cancel-timer; MSSQL_REQUEST_TIMEOUT + per-call timeout_seconds"
```

---

### Task 2: Token efficiency (cell truncation + max_rows)

**Files:**
- Modify: `src/utils/csv.ts` (`formatCSV`)
- Modify: `src/MssqlTools.ts` (const near line 14; ExecuteSqlInputSchema; handleExecuteSql cache key ~line 939 and result shaping ~line 1004-1014)
- Modify: `src/MssqlProfilingTools.ts` (const near line 17; `handleTableSample` line ~253)
- Modify: `src/tests/operations.test.ts` (append sections)

**Interfaces:**
- Consumes: Task 1's `timeout_seconds` (unchanged here).
- Produces: `formatCSV(results, warningMessage?, maxCellChars?)` — third optional param; `MAX_CELL_CHARS` module consts (env `MSSQL_MAX_CELL_CHARS`, default 1000, 0=off); `max_rows` param on exec_sql_csv. exec_sql_csv cache key becomes `getCacheKey(`${query}|max_rows=${max_rows ?? 0}|cell=${MAX_CELL_CHARS}`)` (timeout_seconds deliberately NOT in the key).

- [ ] **Step 1: Append failing tests to `src/tests/operations.test.ts`** (above the summary block). Add imports at top: `import { formatCSV } from '../utils/csv.js';` and `import { MssqlProfilingTools } from '../MssqlProfilingTools.js';`

```ts
console.log('\n--- cell truncation (formatCSV) ---');
{
	const longVal = 'x'.repeat(1500);
	const out = formatCSV([{ a: longVal }], undefined, 1000);
	checkContains('long cell gets truncation marker', out, '...[truncated 500 chars]');
	check('kept exactly maxCellChars prefix', out.includes('x'.repeat(1000)), true);
	check('original full value gone', out.includes('x'.repeat(1001)), false);

	const commaVal = ('y,').repeat(800); // 1600 chars, contains commas → must be quoted
	const out2 = formatCSV([{ a: commaVal }], undefined, 1000);
	checkContains('marker survives CSV quoting (inside quotes)', out2, 'chars]"');

	const out3 = formatCSV([{ a: longVal }]);
	check('no maxCellChars → cell untouched', out3.includes(longVal), true);

	const out4 = formatCSV([{ a: longVal }], undefined, 0);
	check('maxCellChars=0 disables truncation', out4.includes(longVal), true);
}

console.log('\n--- exec_sql_csv max_rows ---');
{
	let queryCount = 0;
	const rows5 = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }];
	const fakePool: any = { name: 'opsB', query: async () => { queryCount++; return rows5.map((r) => ({ ...r })); } };

	const r1 = await MssqlTools.handleTool('exec_sql_csv', { query: 'SELECT n FROM t5', max_rows: 2 }, fakePool);
	checkContains('max_rows note present', r1.content[0].text as string, 'Showing first 2 of 5 fetched rows');
	check('exactly 2 data rows', (r1.content[0].text as string).split('\n').filter((l) => /^\d+$/.test(l)).length, 2);

	const r2 = await MssqlTools.handleTool('exec_sql_csv', { query: 'SELECT n FROM t5', max_rows: 3 }, fakePool);
	check('different max_rows → cache miss (fresh query)', queryCount, 2);
	checkContains('max_rows=3 note', r2.content[0].text as string, 'Showing first 3 of 5');

	await MssqlTools.handleTool('exec_sql_csv', { query: 'SELECT n FROM t5', max_rows: 3 }, fakePool);
	check('same max_rows → cache hit (no new query)', queryCount, 2);
}

console.log('\n--- get_table_sample cell truncation ---');
{
	const fakeSamplePool: any = { name: 'opsC', query: async () => [{ big: 'z'.repeat(1500) }] };
	const s = await MssqlProfilingTools.handleTool('get_table_sample', { table_name: 'TruncT' }, fakeSamplePool);
	checkContains('sample cell truncated', s.content[0].text as string, '...[truncated 500 chars]');
}

console.log('\n--- metadata tools NOT truncated ---');
{
	const longName = 'w'.repeat(1500);
	const fakeMetaPool: any = { name: 'opsD', query: async () => [{ Schema: 's', Name: longName, Type: 'BASE TABLE' }] };
	const lt = await MssqlTools.handleTool('list_tables', {}, fakeMetaPool);
	check('list_tables cell untouched (truncation is exec/sample-only)', (lt.content[0].text as string).includes(longName), true);
}
```

- [ ] **Step 2: Run to verify failure** — `npm run test:operations` → truncation marker checks FAIL.

- [ ] **Step 3: Implement `src/utils/csv.ts`** — replace `formatCSV` with:

```ts
export function formatCSV(results: any[], warningMessage?: string, maxCellChars?: number): string {
	if (!results || results.length === 0) {
		return '';
	}

	const columns = Object.keys(results[0]);
	const needsQuotingRegex = /[,"\n\r]/;

	// PERFORMANCE: Build array first, then join once (avoid repeated string concatenation)
	const lines: string[] = [columns.join(',')];

	for (const row of results) {
		const cells = columns.map((col) => {
			const value = row[col];
			if (value === null || value === undefined) return '';

			// PERFORMANCE: Single regex test instead of 3 includes() calls
			let strValue = String(value);
			// TOKEN EFFICIENCY: truncate very long cells BEFORE quoting so the marker stays readable
			if (maxCellChars && maxCellChars > 0 && strValue.length > maxCellChars) {
				strValue = `${strValue.slice(0, maxCellChars)}...[truncated ${strValue.length - maxCellChars} chars]`;
			}
			if (needsQuotingRegex.test(strValue)) {
				return `"${strValue.replace(/"/g, '""')}"`;
			}
			return strValue;
		});

		lines.push(cells.join(','));
	}

	let resultText = lines.join('\n');

	if (warningMessage) {
		resultText += warningMessage;
	}

	return resultText;
}
```

(Note: the omitted-count template reads `strValue.length` BEFORE reassignment — correct by evaluation order.)

- [ ] **Step 4: Implement MssqlTools changes**

4a. Near `MAX_RESULT_ROWS` (line ~14):

```ts
// TOKEN EFFICIENCY: cells longer than this are truncated with an explicit marker (0 disables)
const MAX_CELL_CHARS = parseInt(process.env.MSSQL_MAX_CELL_CHARS || '1000', 10);
```

4b. `ExecuteSqlInputSchema` gains:

```ts
	max_rows: z.number().int().min(1).optional().describe('Return at most this many rows (token saver — applied after fetch; use TOP in your SQL to also reduce database work).'),
```

4c. Cache key line (currently `const cacheKey = namespaceCacheKey(pool.name, getCacheKey(query));`) becomes:

```ts
			const cacheKey = namespaceCacheKey(pool.name, getCacheKey(`${query}|max_rows=${validatedArgs.max_rows ?? 0}|cell=${MAX_CELL_CHARS}`));
```

4d. After the `WARN_RESULT_ROWS` else-if block and before `const resultText = formatCSV(...)`:

```ts
				// TOKEN EFFICIENCY: per-call row cap (applied after fetch — saves tokens, not DB work)
				if (validatedArgs.max_rows && results.length > validatedArgs.max_rows) {
					const fetchedCount = results.length;
					results = results.slice(0, validatedArgs.max_rows);
					warningMessage += `\n\nℹ️ Showing first ${validatedArgs.max_rows} of ${fetchedCount} fetched rows (max_rows). Use TOP in your SQL to also reduce database work.`;
				}
```

4e. `formatCSV(results, warningMessage)` becomes `formatCSV(results, warningMessage, MAX_CELL_CHARS)`.

- [ ] **Step 5: Implement MssqlProfilingTools changes**

5a. Near the cache consts (line ~17):

```ts
const MAX_CELL_CHARS = parseInt(process.env.MSSQL_MAX_CELL_CHARS || '1000', 10);
```

5b. In `handleTableSample`, `const csv = formatCSV(results);` becomes:

```ts
			const csv = formatCSV(results, undefined, MAX_CELL_CHARS);
```

- [ ] **Step 6: Run tests** — `npm run test:operations` PASS; `npm test` green.

- [ ] **Step 7: Commit**

```bash
git add src/utils/csv.ts src/MssqlTools.ts src/MssqlProfilingTools.ts src/tests/operations.test.ts
git commit -m "feat(token-efficiency): long-cell truncation (MSSQL_MAX_CELL_CHARS) + exec_sql_csv max_rows"
```

---

### Task 3: MssqlPerformanceTools — get_missing_indexes + get_top_queries

**Files:**
- Create: `src/MssqlPerformanceTools.ts`
- Modify: `src/server/MssqlMcpServer.ts` (import ~line 15; ListTools ~line 68; CallTool routing ~line 115)
- Modify: `src/tests/multi-connection.test.ts` (allDefs ~line 67; count line 74: 23 → 25)
- Create: `src/tests/performance-tools.test.ts`
- Modify: `package.json` (`test:performance-tools` + chain)

**Interfaces:**
- Consumes: `ConnectionPool`, `formatCSV`, `buildCacheKeyPrefix`/`namespaceCacheKey`/`parseObjectName`/`validateDatabaseName` from utils/identifier, `ConnectionScopeSchema`.
- Produces: `MssqlPerformanceTools` with `canHandle(name)`, `getToolDefinitions()`, `handleTool(name, args, pool)` — same provider shape as MssqlServerTools. Task 4 adds get_query_plan to this file; Task 5 adds `clearCaches`.

- [ ] **Step 1: Write the failing test — create `src/tests/performance-tools.test.ts`**

```ts
/**
 * Tests for MssqlPerformanceTools (no DB connection required).
 * Run with: npm run test:performance-tools
 */

import { MssqlPerformanceTools } from '../MssqlPerformanceTools.js';

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

console.log('\n--- canHandle / definitions ---');
check('canHandle get_missing_indexes', MssqlPerformanceTools.canHandle('get_missing_indexes'), true);
check('canHandle get_top_queries', MssqlPerformanceTools.canHandle('get_top_queries'), true);
check('canHandle unknown', MssqlPerformanceTools.canHandle('foo'), false);

const defs = MssqlPerformanceTools.getToolDefinitions();
check('exposes 2 tool definitions', defs.length, 2);
const miProps = (defs.find((d) => d.name === 'get_missing_indexes')!.inputSchema as any).properties || {};
check('get_missing_indexes has database_name', !!miProps.database_name, true);
check('get_missing_indexes has table_name', !!miProps.table_name, true);
check('get_missing_indexes has connection_name', !!miProps.connection_name, true);
const tqProps = (defs.find((d) => d.name === 'get_top_queries')!.inputSchema as any).properties || {};
check('get_top_queries has sort_by', !!tqProps.sort_by, true);
check('get_top_queries has top', !!tqProps.top, true);

console.log('\n--- get_missing_indexes SQL construction ---');
{
	let lastSql = '';
	const capturePool: any = { name: 'perfA', query: async (sql: string) => { lastSql = sql; return [{ table: '[D].[dbo].[T]', equality_columns: '[a]' }]; } };

	await MssqlPerformanceTools.handleTool('get_missing_indexes', {}, capturePool);
	checkContains('joins missing_index_details', lastSql, 'sys.dm_db_missing_index_details');
	checkContains('joins group_stats', lastSql, 'sys.dm_db_missing_index_group_stats');
	checkContains('current DB filter', lastSql, 'mid.database_id = DB_ID()');
	checkContains('ordered by improvement', lastSql, 'ORDER BY improvement_measure DESC');
	check('no OBJECT_ID( anywhere (dotted-DB trap)', lastSql.includes('OBJECT_ID('), false);

	lastSql = '';
	await MssqlPerformanceTools.handleTool('get_missing_indexes', { database_name: 'OtherDB' }, capturePool);
	checkContains('cross-DB filter is N-prefixed literal', lastSql, "DB_ID(N'OtherDB')");

	lastSql = '';
	await MssqlPerformanceTools.handleTool('get_missing_indexes', { table_name: 'sales.Orders', database_name: 'OtherDB2' }, capturePool);
	checkContains('table filter via statement LIKE suffix', lastSql, ".\\[sales].\\[Orders]'");
	checkContains('LIKE is escaped', lastSql, "ESCAPE '\\'");
	checkContains('table filter N-prefixed', lastSql, "LIKE N'%");

	const threePart = await MssqlPerformanceTools.handleTool('get_missing_indexes', { table_name: 'DBX.s.t' }, capturePool);
	checkContains('3-part table_name rejected', threePart.content[0].text as string, 'database_name');

	const permPool: any = { name: 'perfB', query: async () => { throw new Error('VIEW SERVER STATE permission was denied on object'); } };
	const perm = await MssqlPerformanceTools.handleTool('get_missing_indexes', {}, permPool);
	checkContains('permission degradation', perm.content[0].text as string, 'GRANT VIEW SERVER STATE');

	let count = 0;
	const countPool: any = { name: 'perfC', query: async () => { count++; return [{ table: 't' }]; } };
	await MssqlPerformanceTools.handleTool('get_missing_indexes', {}, countPool);
	const second = await MssqlPerformanceTools.handleTool('get_missing_indexes', {}, countPool);
	check('second call served from cache', count, 1);
	checkContains('cached marker', second.content[0].text as string, 'Cached result');
}

console.log('\n--- get_top_queries SQL construction ---');
{
	let lastSql = '';
	let count = 0;
	const capturePool: any = { name: 'perfD', query: async (sql: string) => { lastSql = sql; count++; return [{ query_text: 'SELECT 1', execution_count: 5 }]; } };

	await MssqlPerformanceTools.handleTool('get_top_queries', {}, capturePool);
	checkContains('default TOP 20', lastSql, 'SELECT TOP 20');
	checkContains('default sort avg_elapsed', lastSql, 'ORDER BY qs.total_elapsed_time / qs.execution_count DESC');
	checkContains('reads plan cache stats', lastSql, 'sys.dm_exec_query_stats');

	await MssqlPerformanceTools.handleTool('get_top_queries', { sort_by: 'cpu', top: 50 }, capturePool);
	checkContains('cpu sort', lastSql, 'ORDER BY qs.total_worker_time DESC');
	checkContains('top 50 honored', lastSql, 'SELECT TOP 50');

	const tooMany = await MssqlPerformanceTools.handleTool('get_top_queries', { top: 51 }, capturePool);
	checkContains('top 51 rejected by Zod', tooMany.content[0].text as string, 'Error');

	const dbf = await MssqlPerformanceTools.handleTool('get_top_queries', { database_name: 'FiltDB' }, capturePool);
	checkContains('dbid filter N-prefixed', lastSql, "st.dbid = DB_ID(N'FiltDB')");
	checkContains('ad-hoc NULL dbid note', dbf.content[0].text as string, 'ad-hoc');

	const before = count;
	await MssqlPerformanceTools.handleTool('get_top_queries', {}, capturePool);
	check('get_top_queries is NOT cached', count, before + 1);

	const permPool: any = { name: 'perfE', query: async () => { throw new Error('The user does not have permission to perform this action.'); } };
	const perm = await MssqlPerformanceTools.handleTool('get_top_queries', {}, permPool);
	checkContains('permission degradation', perm.content[0].text as string, 'GRANT VIEW SERVER STATE');
}

// --- summary (KEEP LAST — Task 4 appends ABOVE this block) ---
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: package.json** — add `"test:performance-tools": "node --loader ts-node/esm src/tests/performance-tools.test.ts"` and append the file to the `"test"` chain (after operations.test.ts).

- [ ] **Step 3: Run to verify failure** — `npm run test:performance-tools` → FAIL (module not found).

- [ ] **Step 4: Create `src/MssqlPerformanceTools.ts`** (complete file):

```ts
import type { TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import { z } from 'zod/v4';
import type { ConnectionPool } from './server/connection.js';
import { formatCSV } from './utils/csv.js';
import { buildCacheKeyPrefix, namespaceCacheKey, parseObjectName, validateDatabaseName } from './utils/identifier.js';
import { ConnectionScopeSchema } from './utils/connectionScope.js';

const logger = consola.withTag('mssql-performance-tools');

interface ToolCacheEntry {
	result: string;
	timestamp: number;
	lastAccessed: number;
}

const MISSING_INDEXES_CACHE_TTL_MS = parseInt(process.env.MSSQL_MISSING_INDEXES_CACHE_TTL || '300000', 10);
const MISSING_INDEXES_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_MISSING_INDEXES_CACHE_SIZE || '50', 10);

const missingIndexesCache = new Map<string, ToolCacheEntry>();

function cleanExpired(cache: Map<string, ToolCacheEntry>, key: string, ttlMs: number): boolean {
	const entry = cache.get(key);
	if (entry && Date.now() - entry.timestamp > ttlMs) {
		cache.delete(key);
		return true;
	}
	return false;
}

function enforceSizeLimit(cache: Map<string, ToolCacheEntry>, maxSize: number, name: string): void {
	if (cache.size > maxSize) {
		const entries = Array.from(cache.entries()).sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
		const toDelete = cache.size - maxSize;
		for (let i = 0; i < toDelete; i++) cache.delete(entries[i][0]);
		if (consola.level >= 0) logger.debug(`${name} LRU eviction: removed ${toDelete} entries`);
	}
}

function getFromCache(cache: Map<string, ToolCacheEntry>, key: string, ttlMs: number): string | null {
	if (!cleanExpired(cache, key, ttlMs)) {
		const entry = cache.get(key);
		if (entry) {
			entry.lastAccessed = Date.now();
			return entry.result;
		}
	}
	return null;
}

function setInCache(cache: Map<string, ToolCacheEntry>, key: string, result: string, maxSize: number, name: string): void {
	const now = Date.now();
	cache.set(key, { result, timestamp: now, lastAccessed: now });
	enforceSizeLimit(cache, maxSize, name);
}

function escapeLiteral(s: string): string {
	return s.replace(/'/g, "''");
}

function escapeLikePattern(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/[%_\[]/g, (c) => `\\${c}`);
}

function plainResponse(text: string): { content: TextContent[] } {
	return { content: [{ type: 'text', text }] };
}

function cachedResponse(text: string): { content: TextContent[] } {
	return { content: [{ type: 'text', text: `${text}\n\n📋 (Cached result)` }] };
}

function errorResponse(prefix: string, error: unknown): { content: TextContent[] } {
	const msg = error instanceof Error ? error.message : 'Unknown error';
	return { content: [{ type: 'text', text: `${prefix}: ${msg}` }] };
}

function isPermissionError(error: unknown): boolean {
	const msg = error instanceof Error ? error.message.toLowerCase() : '';
	return msg.includes('permission') || msg.includes('denied');
}

function viewServerStateHint(toolName: string): string {
	return `🔒 ${toolName} requires the VIEW SERVER STATE permission, which this connection's user lacks. Ask a DBA to run: GRANT VIEW SERVER STATE TO [your_login];`;
}

const MISSING_INDEXES_NOTES = '\n\nℹ️ Suggestions reset when SQL Server restarts and are hints only — they are not deduplicated against existing indexes, and column order within a suggested index is not encoded here.';
const TOP_QUERIES_NOTES = '\n\nℹ️ Stats accumulate since each plan entered the cache and reset on server restart or plan eviction. Pair with get_query_plan to inspect a specific query.';

const GetMissingIndexesInputSchema = z.object({
	database_name: z.string().optional().describe("Optional cross-database scope. If omitted, uses the connection's current database. Only alphanumeric and underscore characters allowed."),
	table_name: z.string().optional().describe('Optional table filter as "table" or "schema.table" (schema defaults to dbo). For another database, pass database_name separately.'),
});

const SORT_EXPRESSIONS: Record<string, string> = {
	avg_elapsed: 'qs.total_elapsed_time / qs.execution_count',
	total_elapsed: 'qs.total_elapsed_time',
	cpu: 'qs.total_worker_time',
	reads: 'qs.total_logical_reads',
	executions: 'qs.execution_count',
};

const GetTopQueriesInputSchema = z.object({
	sort_by: z.enum(['avg_elapsed', 'total_elapsed', 'cpu', 'reads', 'executions']).optional().describe('Sort metric (default: avg_elapsed).'),
	top: z.number().int().min(1).max(50).optional().describe('Number of queries to return (default 20, max 50).'),
	database_name: z.string().optional().describe('Optional database filter. Note: excludes ad-hoc queries whose dbid is NULL.'),
});

const TOOL_NAMES = new Set(['get_missing_indexes', 'get_top_queries']);

export const MssqlPerformanceTools = {
	canHandle(name: string): boolean {
		return TOOL_NAMES.has(name);
	},

	getToolDefinitions(): Tool[] {
		return [
			{
				name: 'get_missing_indexes',
				description: 'Get missing-index suggestions recorded by SQL Server for real workloads: table, equality/inequality/included columns, estimated impact %, seek/scan counts, and an improvement measure (TOP 25 by impact). Requires VIEW SERVER STATE (friendly diagnostic when missing). Suggestions reset on server restart and are hints — not deduplicated against existing indexes.',
				inputSchema: z.toJSONSchema(GetMissingIndexesInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
			{
				name: 'get_top_queries',
				description: 'List the heaviest queries from the server plan cache with execution count, total/avg elapsed ms, CPU ms, logical reads, and last execution time. sort_by: avg_elapsed (default) | total_elapsed | cpu | reads | executions; top 1-50 (default 20). Requires VIEW SERVER STATE. Stats reset on restart or plan eviction.',
				inputSchema: z.toJSONSchema(GetTopQueriesInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
		];
	},

	async handleTool(name: string, args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		switch (name) {
			case 'get_missing_indexes':
				return this.handleGetMissingIndexes(args, pool);
			case 'get_top_queries':
				return this.handleGetTopQueries(args, pool);
		}
		throw new Error(`Unknown tool: ${name}`);
	},

	async handleGetMissingIndexes(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = GetMissingIndexesInputSchema.parse(args);

			let dbFilter = 'DB_ID()';
			let dbCacheKey = buildCacheKeyPrefix();
			if (v.database_name) {
				validateDatabaseName(v.database_name);
				dbFilter = `DB_ID(N'${escapeLiteral(v.database_name)}')`;
				dbCacheKey = buildCacheKeyPrefix(v.database_name);
			}

			let tableClause = '';
			let tableCacheKey = '_all_';
			if (v.table_name) {
				const parts = parseObjectName(v.table_name);
				if (parts.database) {
					return plainResponse('3-part table names are not supported here — pass the database via the separate database_name parameter.');
				}
				const schemaPart = parts.schema ?? 'dbo';
				const suffix = escapeLikePattern(`.[${schemaPart}].[${parts.object}]`);
				tableClause = ` AND mid.statement LIKE N'%${suffix}' ESCAPE '\\'`;
				tableCacheKey = `${schemaPart}.${parts.object}`;
			}

			const cacheKey = namespaceCacheKey(pool.name, `${dbCacheKey}${tableCacheKey}`);
			const cached = getFromCache(missingIndexesCache, cacheKey, MISSING_INDEXES_CACHE_TTL_MS);
			if (cached !== null) return cachedResponse(cached);

			const query = `SELECT TOP 25 mid.statement AS [table], mid.equality_columns, mid.inequality_columns, mid.included_columns, CAST(migs.avg_user_impact AS DECIMAL(5,1)) AS avg_user_impact_pct, migs.user_seeks, migs.user_scans, CAST(migs.avg_total_user_cost AS DECIMAL(12,2)) AS avg_total_user_cost, CONVERT(VARCHAR(19), migs.last_user_seek, 120) AS last_user_seek, CAST(migs.avg_user_impact * (migs.user_seeks + migs.user_scans) * migs.avg_total_user_cost AS DECIMAL(18,2)) AS improvement_measure FROM sys.dm_db_missing_index_details mid INNER JOIN sys.dm_db_missing_index_groups mig ON mig.index_handle = mid.index_handle INNER JOIN sys.dm_db_missing_index_group_stats migs ON migs.group_handle = mig.index_group_handle WHERE mid.database_id = ${dbFilter}${tableClause} ORDER BY improvement_measure DESC`;

			if (consola.level >= 0) logger.info(`Getting missing indexes (${v.database_name || 'current DB'}${v.table_name ? `, table ${v.table_name}` : ''})`);
			let results;
			try {
				results = await pool.query(query);
			} catch (e) {
				if (isPermissionError(e)) return plainResponse(viewServerStateHint('get_missing_indexes'));
				throw e;
			}

			if (!results || results.length === 0) {
				return plainResponse(`No missing-index suggestions recorded${v.table_name ? ` for ${v.table_name}` : ''}. Either the workload is well-indexed or the counters were reset by a restart.${MISSING_INDEXES_NOTES}`);
			}

			const csv = formatCSV(results) + MISSING_INDEXES_NOTES;
			setInCache(missingIndexesCache, cacheKey, csv, MISSING_INDEXES_CACHE_MAX_SIZE, 'get_missing_indexes');
			return plainResponse(csv);
		} catch (error) {
			if (consola.level >= 0) logger.error('get_missing_indexes error:', error);
			return errorResponse('Error getting missing indexes', error);
		}
	},

	async handleGetTopQueries(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = GetTopQueriesInputSchema.parse(args);
			const sortExpr = SORT_EXPRESSIONS[v.sort_by ?? 'avg_elapsed'];
			const top = v.top ?? 20;

			let dbClause = '';
			let dbNote = '';
			if (v.database_name) {
				validateDatabaseName(v.database_name);
				dbClause = ` WHERE st.dbid = DB_ID(N'${escapeLiteral(v.database_name)}')`;
				dbNote = '\n\nℹ️ The database_name filter excludes ad-hoc queries whose dbid is NULL.';
			}

			const query = `SELECT TOP ${top} REPLACE(REPLACE(REPLACE(SUBSTRING(st.text, 1, 200), CHAR(13), ' '), CHAR(10), ' '), CHAR(9), ' ') AS query_text, DB_NAME(st.dbid) AS database_name, qs.execution_count, CAST(qs.total_elapsed_time / 1000.0 AS DECIMAL(18,1)) AS total_elapsed_ms, CAST(qs.total_elapsed_time / qs.execution_count / 1000.0 AS DECIMAL(18,1)) AS avg_elapsed_ms, CAST(qs.total_worker_time / 1000.0 AS DECIMAL(18,1)) AS total_cpu_ms, qs.total_logical_reads, qs.total_logical_reads / qs.execution_count AS avg_logical_reads, CONVERT(VARCHAR(19), qs.last_execution_time, 120) AS last_execution FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st${dbClause} ORDER BY ${sortExpr} DESC`;

			if (consola.level >= 0) logger.info(`Getting top ${top} queries by ${v.sort_by ?? 'avg_elapsed'}`);
			let results;
			try {
				results = await pool.query(query);
			} catch (e) {
				if (isPermissionError(e)) return plainResponse(viewServerStateHint('get_top_queries'));
				throw e;
			}

			if (!results || results.length === 0) {
				return plainResponse(`No queries found in the plan cache${v.database_name ? ` for database ${v.database_name}` : ''}.${TOP_QUERIES_NOTES}`);
			}

			// Not cached: live diagnostic data.
			return plainResponse(formatCSV(results) + TOP_QUERIES_NOTES + dbNote);
		} catch (error) {
			if (consola.level >= 0) logger.error('get_top_queries error:', error);
			return errorResponse('Error getting top queries', error);
		}
	},
};
```

- [ ] **Step 5: Wire routing in `src/server/MssqlMcpServer.ts`**

5a. Import (alphabetical position, after MssqlObjectTools): `import { MssqlPerformanceTools } from '../MssqlPerformanceTools.js';`

5b. ListTools handler `tools` array gains `...MssqlPerformanceTools.getToolDefinitions(),` after the profiling spread.

5c. CallTool routing: after the `MssqlProfilingTools.canHandle` branch, before the fallback:

```ts
			if (MssqlPerformanceTools.canHandle(name)) {
				return await MssqlPerformanceTools.handleTool(name, args, pool);
			}
```

- [ ] **Step 6: Update `src/tests/multi-connection.test.ts`** — add `import { MssqlPerformanceTools } from '../MssqlPerformanceTools.js';`, add `...MssqlPerformanceTools.getToolDefinitions(),` to the `allDefs` array, and change `check('23 tool definitions total', allDefs.length, 23);` to `check('25 tool definitions total', allDefs.length, 25);`

- [ ] **Step 7: Run tests** — `npm run test:performance-tools` PASS; `npm test` green.

- [ ] **Step 8: Commit**

```bash
git add src/MssqlPerformanceTools.ts src/server/MssqlMcpServer.ts src/tests/performance-tools.test.ts src/tests/multi-connection.test.ts package.json
git commit -m "feat(performance-tools): add get_missing_indexes and get_top_queries (DMV-based, graceful VIEW SERVER STATE degradation)"
```

---

### Task 4: get_query_plan (estimated plan via ephemeral connection)

**Files:**
- Modify: `src/server/connection.ts` (EphemeralConnection interface + ConnectionPool optional method + ResilientConnectionPool implementation)
- Modify: `src/MssqlPerformanceTools.ts` (schema, tool def, handler, TOOL_NAMES)
- Modify: `src/tests/performance-tools.test.ts` (append; change defs count 2 → 3)
- Modify: `src/tests/multi-connection.test.ts` (count 25 → 26)

**Interfaces:**
- Consumes: Task 3's provider file; `isReadOnlyQuery` from `./server/config.js`.
- Produces: in connection.ts —

```ts
export interface EphemeralConnection {
	batch(sqlText: string): Promise<void>;
	query<T = any>(sqlText: string): Promise<T[]>;
	close(): Promise<void>;
}
```

and `ConnectionPool` gains OPTIONAL `createEphemeralConnection?(databaseOverride?: string): Promise<EphemeralConnection>;`

- [ ] **Step 1: Append failing tests to `src/tests/performance-tools.test.ts`** (above the summary; also change `check('exposes 2 tool definitions', defs.length, 2)` to `check('exposes 3 tool definitions', defs.length, 3);`):

```ts
console.log('\n--- get_query_plan ---');
{
	check('canHandle get_query_plan', MssqlPerformanceTools.canHandle('get_query_plan'), true);

	// write query rejected BEFORE any connection is opened
	let ephemeralCalls = 0;
	const guardPool: any = {
		name: 'planA',
		query: async () => [],
		createEphemeralConnection: async () => { ephemeralCalls++; throw new Error('should not be called'); },
	};
	const rejected = await MssqlPerformanceTools.handleTool('get_query_plan', { query: 'DROP TABLE x' }, guardPool);
	checkContains('write query rejected', rejected.content[0].text as string, 'READ-ONLY');
	check('no ephemeral connection opened for rejected query', ephemeralCalls, 0);

	// happy path
	const batches: string[] = [];
	const queries: string[] = [];
	let closed = false;
	let dbOverrideSeen: string | undefined = 'unset' as any;
	const happyPool: any = {
		name: 'planB',
		query: async () => [],
		createEphemeralConnection: async (dbOverride?: string) => {
			dbOverrideSeen = dbOverride;
			return {
				batch: async (s: string) => { batches.push(s); },
				query: async (q: string) => { queries.push(q); return [{ 'Microsoft SQL Server 2005 XML Showplan': '<ShowPlanXML>plan</ShowPlanXML>' }]; },
				close: async () => { closed = true; },
			};
		},
	};
	const plan = await MssqlPerformanceTools.handleTool('get_query_plan', { query: 'SELECT 1 AS a', database_name: 'OtherDB' }, happyPool);
	checkContains('plan XML returned', plan.content[0].text as string, '<ShowPlanXML>');
	checkContains('marked as estimated / not executed', plan.content[0].text as string, 'NOT executed');
	check('SHOWPLAN batch sent first', batches[0], 'SET SHOWPLAN_XML ON');
	check('query sent on same ephemeral connection', queries[0], 'SELECT 1 AS a');
	check('database override forwarded', dbOverrideSeen, 'OtherDB');
	check('ephemeral connection closed', closed, true);

	// close() must run even when the query throws (finally)
	let closed2 = false;
	const failPool: any = {
		name: 'planC',
		query: async () => [],
		createEphemeralConnection: async () => ({
			batch: async () => {},
			query: async () => { throw new Error('SHOWPLAN permission denied in database'); },
			close: async () => { closed2 = true; },
		}),
	};
	const permErr = await MssqlPerformanceTools.handleTool('get_query_plan', { query: 'SELECT 2 AS b' }, failPool);
	checkContains('SHOWPLAN permission hint', permErr.content[0].text as string, 'GRANT SHOWPLAN');
	check('connection closed on error too', closed2, true);

	// pool without the method → clear error
	const legacyPool: any = { name: 'planD', query: async () => [] };
	const unsupported = await MssqlPerformanceTools.handleTool('get_query_plan', { query: 'SELECT 3 AS c' }, legacyPool);
	checkContains('unsupported pool message', unsupported.content[0].text as string, 'not supported');

	// 100k truncation
	const bigPool: any = {
		name: 'planE',
		query: async () => [],
		createEphemeralConnection: async () => ({
			batch: async () => {},
			query: async () => [{ plan: '<x>' + 'p'.repeat(100050) + '</x>' }],
			close: async () => {},
		}),
	};
	const big = await MssqlPerformanceTools.handleTool('get_query_plan', { query: 'SELECT 4 AS d' }, bigPool);
	checkContains('oversized plan truncated', big.content[0].text as string, '...[truncated]');
	checkContains('truncation note', big.content[0].text as string, 'Plan truncated at 100000');
}
```

- [ ] **Step 2: Run to verify failure** — `npm run test:performance-tools` → FAIL (canHandle false).

- [ ] **Step 3: Implement connection.ts ephemeral support**

3a. Add after `QueryOptions`:

```ts
/**
 * A dedicated one-off connection for session-scoped statements (SET SHOWPLAN_XML ON).
 * Never taken from the shared pool — pool poisoning is structurally impossible
 * because the connection is closed after use.
 */
export interface EphemeralConnection {
	batch(sqlText: string): Promise<void>;
	query<T = any>(sqlText: string): Promise<T[]>;
	close(): Promise<void>;
}
```

3b. `ConnectionPool` interface gains:

```ts
	createEphemeralConnection?(databaseOverride?: string): Promise<EphemeralConnection>;
```

3c. `ResilientConnectionPool` gains a method (after `query`, before `close`):

```ts
	async createEphemeralConnection(databaseOverride?: string): Promise<EphemeralConnection> {
		const config: sql.config = {
			...buildMssqlConfig(this.localConfig),
			pool: { max: 1, min: 0, idleTimeoutMillis: 5000 },
		};
		if (databaseOverride) config.database = databaseOverride;
		const conn = new sql.ConnectionPool(config);
		await conn.connect();
		return {
			async batch(sqlText: string): Promise<void> {
				await conn.request().batch(sqlText);
			},
			async query<T = any>(sqlText: string): Promise<T[]> {
				const result = await conn.request().query(sqlText);
				return result.recordset as T[];
			},
			async close(): Promise<void> {
				try { await conn.close(); } catch { /* ignore close errors */ }
			},
		};
	}
```

- [ ] **Step 4: Implement the tool in MssqlPerformanceTools.ts**

4a. Imports: add `import { isReadOnlyQuery } from './server/config.js';` and extend the connection import: `import type { ConnectionPool, EphemeralConnection } from './server/connection.js';`

4b. Add near the other schemas:

```ts
const PLAN_MAX_CHARS = 100000;

const GetQueryPlanInputSchema = z.object({
	query: z.string().min(1).describe('The SELECT query to plan. It is NEVER executed — only compiled.'),
	database_name: z.string().optional().describe("Optional database to plan against (the one-off connection opens directly in it). If omitted, uses the connection's current database."),
});
```

4c. `TOOL_NAMES` gains `'get_query_plan'`; `getToolDefinitions()` gains:

```ts
			{
				name: 'get_query_plan',
				description: 'Get the ESTIMATED execution plan (SHOWPLAN XML) for a SELECT query WITHOUT executing it, on a dedicated one-off connection. The query must pass the same read-only validation as exec_sql_csv — blocked keywords (UNION, EXEC, INTO, ...) are rejected here too. Requires SHOWPLAN permission (friendly diagnostic when missing).',
				inputSchema: z.toJSONSchema(GetQueryPlanInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
```

4d. `handleTool` switch gains `case 'get_query_plan': return this.handleGetQueryPlan(args, pool);`

4e. Handler:

```ts
	async handleGetQueryPlan(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = GetQueryPlanInputSchema.parse(args);

			// SECURITY: same multi-layer validation as exec_sql_csv, BEFORE any connection is opened.
			if (!isReadOnlyQuery(v.query)) {
				return plainResponse('Error: This MCP server is READ-ONLY. Only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, and DESC queries are permitted — this applies to plan requests too, including blocked keywords like UNION and EXEC.');
			}
			if (v.database_name) validateDatabaseName(v.database_name);

			if (typeof pool.createEphemeralConnection !== 'function') {
				return plainResponse('get_query_plan is not supported by this connection pool (requires ephemeral connection support).');
			}

			if (consola.level >= 0) logger.info('Getting estimated query plan via ephemeral connection');
			let conn: EphemeralConnection | null = null;
			try {
				conn = await pool.createEphemeralConnection(v.database_name);
				await conn.batch('SET SHOWPLAN_XML ON');
				const rows = await conn.query(v.query);
				const first = rows && rows[0] ? Object.values(rows[0] as Record<string, unknown>)[0] : null;
				if (!first || typeof first !== 'string') {
					return plainResponse('No plan returned — the server did not produce a showplan for this query.');
				}
				let planXml = first;
				let note = '';
				if (planXml.length > PLAN_MAX_CHARS) {
					note = `\n\nℹ️ Plan truncated at ${PLAN_MAX_CHARS} chars (original ${planXml.length}).`;
					planXml = `${planXml.slice(0, PLAN_MAX_CHARS)}...[truncated]`;
				}
				return plainResponse(`Estimated execution plan (query was NOT executed):\n${planXml}${note}`);
			} catch (e) {
				const msg = e instanceof Error ? e.message.toLowerCase() : '';
				if (msg.includes('showplan')) {
					return plainResponse(`🔒 get_query_plan requires the SHOWPLAN permission, which this connection's user lacks. Ask a DBA to run: GRANT SHOWPLAN TO [your_login];`);
				}
				throw e;
			} finally {
				if (conn) await conn.close();
			}
		} catch (error) {
			if (consola.level >= 0) logger.error('get_query_plan error:', error);
			return errorResponse('Error getting query plan', error);
		}
	},
```

- [ ] **Step 5: multi-connection.test.ts count 25 → 26.**

- [ ] **Step 6: Run tests** — `npm run test:performance-tools` PASS; `npm test` green.

- [ ] **Step 7: Commit**

```bash
git add src/server/connection.ts src/MssqlPerformanceTools.ts src/tests/performance-tools.test.ts src/tests/multi-connection.test.ts
git commit -m "feat(performance-tools): add get_query_plan — estimated SHOWPLAN_XML on a dedicated ephemeral connection"
```

---

### Task 5: clear_cache tool + clearCaches exports

**Files:**
- Create: `src/utils/cacheClear.ts`
- Modify: `src/MssqlTools.ts`, `src/MssqlObjectTools.ts`, `src/MssqlProfilingTools.ts`, `src/MssqlPerformanceTools.ts`, `src/MssqlResources.ts` (each gains `clearCaches`)
- Modify: `src/MssqlServerTools.ts` (imports, schema, TOOL_NAMES, tool def, handler, own `clearCaches`)
- Modify: `src/tests/operations.test.ts` (append), `src/tests/multi-connection.test.ts` (count 26 → 27)

**Interfaces:**
- Produces: `clearMapByPrefix(map: Map<string, unknown>, connectionName?: string): number` in utils/cacheClear.ts (no-arg → full clear returning previous size; with name → delete keys starting with `` `${connectionName}::` ``); every layer object gains `clearCaches(connectionName?: string): number`.
- Import direction: MssqlServerTools imports the other 4 layers + MssqlResources; none of them import MssqlServerTools → no cycle.

- [ ] **Step 1: Append failing tests to `src/tests/operations.test.ts`** (above summary). Add import: `import { MssqlServerTools } from '../MssqlServerTools.js';`

```ts
console.log('\n--- clear_cache ---');
{
	const mkPool = (n: string): any => ({ name: n, query: async () => [{ Schema: 's', Name: 'T', Type: 'BASE TABLE' }] });
	const poolA = mkPool('connA');
	const poolB = mkPool('connB');
	await MssqlTools.handleTool('list_tables', {}, poolA);
	await MssqlTools.handleTool('list_tables', {}, poolB);

	const clearedA = MssqlTools.clearCaches('connA');
	check('clearCaches(connA) removed at least one entry', clearedA >= 1, true);

	const again = await MssqlTools.handleTool('list_tables', {}, poolB);
	checkContains('connB entries survive a connA-filtered clear', again.content[0].text as string, 'Cached result');

	const res = await MssqlServerTools.handleTool('clear_cache', {}, poolA);
	checkContains('clear_cache reports table_tools layer', res.content[0].text as string, 'table_tools');
	checkContains('clear_cache reports performance_tools layer', res.content[0].text as string, 'performance_tools');
	checkContains('clear_cache reports resources layer', res.content[0].text as string, 'resources');
	checkContains('clear_cache reports total', res.content[0].text as string, 'Total:');
	checkContains('repopulation note', res.content[0].text as string, 'slower');

	const fresh = await MssqlTools.handleTool('list_tables', {}, poolB);
	check('full clear emptied connB too (no cached marker)', (fresh.content[0].text as string).includes('Cached result'), false);
}
```

- [ ] **Step 2: Run to verify failure** — `npm run test:operations` → FAIL (`clearCaches` is not a function).

- [ ] **Step 3: Create `src/utils/cacheClear.ts`**

```ts
/**
 * Shared cache-clearing helper for the clear_cache tool.
 * Cache keys are namespaced as `${connectionName}::${rawKey}` (see
 * namespaceCacheKey in utils/identifier.ts), so a connection-filtered clear
 * is a prefix scan.
 */
export function clearMapByPrefix(map: Map<string, unknown>, connectionName?: string): number {
	if (!connectionName) {
		const n = map.size;
		map.clear();
		return n;
	}
	const prefix = `${connectionName}::`;
	let n = 0;
	for (const key of [...map.keys()]) {
		if (key.startsWith(prefix)) {
			map.delete(key);
			n++;
		}
	}
	return n;
}
```

- [ ] **Step 4: Add `clearCaches` to each layer** (each is a new method on the exported object; add `import { clearMapByPrefix } from './utils/cacheClear.js';` to each file):

`src/MssqlTools.ts` (note the version cache is keyed by BARE connection name):

```ts
	clearCaches(connectionName?: string): number {
		let cleared = 0;
		for (const cache of [queryCache, listTablesCache, tableSchemaCache, foreignKeysCache, relationshipsCache, columnsCache, indexesCache]) {
			cleared += clearMapByPrefix(cache as Map<string, unknown>, connectionName);
		}
		if (connectionName) {
			if (versionCache.delete(connectionName)) cleared++;
		} else {
			cleared += versionCache.size;
			versionCache.clear();
		}
		return cleared;
	},
```

`src/MssqlObjectTools.ts`:

```ts
	clearCaches(connectionName?: string): number {
		let cleared = 0;
		for (const cache of [procsCache, viewsCache, functionsCache, triggersCache, definitionsCache, searchCache, depsCache]) {
			cleared += clearMapByPrefix(cache as Map<string, unknown>, connectionName);
		}
		return cleared;
	},
```

`src/MssqlProfilingTools.ts`:

```ts
	clearCaches(connectionName?: string): number {
		let cleared = 0;
		for (const cache of [profileCache, rowCountCache]) {
			cleared += clearMapByPrefix(cache as Map<string, unknown>, connectionName);
		}
		return cleared;
	},
```

`src/MssqlPerformanceTools.ts`:

```ts
	clearCaches(connectionName?: string): number {
		return clearMapByPrefix(missingIndexesCache as Map<string, unknown>, connectionName);
	},
```

`src/MssqlResources.ts` (current single-object cache; Task 6 upgrades this):

```ts
	clearCaches(_connectionName?: string): number {
		const n = resourceCache ? 1 : 0;
		resourceCache = null;
		return n;
	},
```

**IMPORTANT (ts-node resolution):** MssqlResources.ts currently uses EXTENSIONLESS relative imports (`'./server/config'`, `'./server/connection'`, `'./utils/csv'`). Until now no test loaded this file under ts-node; this task makes MssqlServerTools import it, so the ESM loader will now resolve it. Change those three imports to include the `.js` extension (`'./server/config.js'`, `'./server/connection.js'`, `'./utils/csv.js'`) in this task, or `npm test` fails with ERR_MODULE_NOT_FOUND.

- [ ] **Step 5: Add the tool to `src/MssqlServerTools.ts`**

5a. Imports:

```ts
import { MssqlObjectTools } from './MssqlObjectTools.js';
import { MssqlPerformanceTools } from './MssqlPerformanceTools.js';
import { MssqlProfilingTools } from './MssqlProfilingTools.js';
import { MssqlResources } from './MssqlResources.js';
import { MssqlTools } from './MssqlTools.js';
import { clearMapByPrefix } from './utils/cacheClear.js';
```

5b. Schema (near the other schemas) — deliberately NOT extending ConnectionScopeSchema (its own description differs):

```ts
const ClearCacheInputSchema = z.object({
	connection_name: z.string().optional().describe('Clear only cache entries belonging to this connection. Omit to clear all cached data for every connection.'),
});
```

5c. `TOOL_NAMES` gains `'clear_cache'`. Tool def added to `getToolDefinitions()`:

```ts
			{
				name: 'clear_cache',
				description: 'Clear the server-side metadata/result caches (schema, tables, definitions, query results, ...). Use after the database schema changed and tools are returning stale cached data. Executes NO SQL. Optional connection_name clears only that connection\'s entries. First queries after clearing will be slower while caches repopulate.',
				inputSchema: z.toJSONSchema(ClearCacheInputSchema) as any,
			},
```

5d. `handleTool` switch gains `case 'clear_cache': return this.handleClearCache(args);`

5e. Methods (before `clearCachesForTesting`):

```ts
	clearCaches(connectionName?: string): number {
		let cleared = 0;
		for (const cache of [databasesCache, schemasCache, linkedServersCache, serverInfoCache]) {
			cleared += clearMapByPrefix(cache as Map<string, unknown>, connectionName);
		}
		return cleared;
	},

	handleClearCache(args: any): { content: TextContent[] } {
		try {
			const v = ClearCacheInputSchema.parse(args);
			const conn = v.connection_name;
			const rows = [
				{ layer: 'table_tools', entries_cleared: MssqlTools.clearCaches(conn) },
				{ layer: 'object_tools', entries_cleared: MssqlObjectTools.clearCaches(conn) },
				{ layer: 'server_tools', entries_cleared: this.clearCaches(conn) },
				{ layer: 'profiling_tools', entries_cleared: MssqlProfilingTools.clearCaches(conn) },
				{ layer: 'performance_tools', entries_cleared: MssqlPerformanceTools.clearCaches(conn) },
				{ layer: 'resources', entries_cleared: MssqlResources.clearCaches(conn) },
			];
			const total = rows.reduce((s, r) => s + r.entries_cleared, 0);
			return plainResponse(`${formatCSV(rows)}\n\nTotal: ${total} entries cleared${conn ? ` for connection "${conn}"` : ''}.\nℹ️ First queries after clearing will be slower while caches repopulate.`);
		} catch (error) {
			if (consola.level >= 0) logger.error('clear_cache error:', error);
			return errorResponse('Error clearing caches', error);
		}
	},
```

Note: the server's `resolvePoolForCall` still runs for clear_cache — an unknown `connection_name` fails there with a clear "Unknown connection" error, which is the desired behavior; the handler itself never touches the pool.

- [ ] **Step 6: multi-connection.test.ts count 26 → 27.**

- [ ] **Step 7: Run tests** — `npm run test:operations` PASS; `npm test` green.

- [ ] **Step 8: Commit**

```bash
git add src/utils/cacheClear.ts src/MssqlTools.ts src/MssqlObjectTools.ts src/MssqlProfilingTools.ts src/MssqlPerformanceTools.ts src/MssqlResources.ts src/MssqlServerTools.ts src/tests/operations.test.ts src/tests/multi-connection.test.ts
git commit -m "feat(server-tools): add clear_cache tool — clears all layer caches, optional connection filter, no SQL"
```

---

### Task 6: Resources multi-connection

**Files:**
- Modify: `src/MssqlResources.ts` (rewrite — full content below)
- Modify: `src/server/MssqlMcpServer.ts` (ListResources + ReadResource handlers pass `this.registry`)
- Modify: `src/tests/operations.test.ts` (append)

**Interfaces:**
- Consumes: `ConnectionRegistry` (`list(): ConnectionInfo[]`, `get(name?): pool` — throws on unknown name, defaults when omitted).
- Produces: `MssqlResources.getResourceDefinitions(registry)`, `MssqlResources.handleResource(uri, registry)`, `MssqlResources.clearCaches(connectionName?)` (per-connection map version, replacing Task 5's single-object version). URIs: single connection → `mssql://{table}/data` (unchanged); multiple → `mssql://{connection}/{table}/data`; reads accept both forms.

- [ ] **Step 1: Append failing tests to `src/tests/operations.test.ts`** (above summary). Add import: `import { MssqlResources } from '../MssqlResources.js';`

```ts
console.log('\n--- resources multi-connection ---');
{
	const tPool = (n: string): any => ({ name: n, query: async (sql: string) => (sql.includes('INFORMATION_SCHEMA.TABLES') ? [{ TABLE_NAME: `tbl_${n}` }] : [{ c: 1 }]) });
	const poolRa = tPool('ra');
	const poolRb = tPool('rb');
	const info = (n: string, d: boolean) => ({ name: n, server: 's', database: 'd', user: 'u', is_default: d });

	const multiRegistry: any = { list: () => [info('ra', true), info('rb', false)], get: (n?: string) => (n === 'rb' ? poolRb : poolRa) };
	const defsMulti = await MssqlResources.getResourceDefinitions(multiRegistry);
	check('two connections → two resources', defsMulti.length, 2);
	checkContains('multi URI carries connection name', defsMulti.map((r) => r.uri).join(','), 'mssql://ra/tbl_ra/data');
	checkContains('second connection listed too', defsMulti.map((r) => r.uri).join(','), 'mssql://rb/tbl_rb/data');

	const singleRegistry: any = { list: () => [info('solo', true)], get: () => tPool('solo') };
	const defsSingle = await MssqlResources.getResourceDefinitions(singleRegistry);
	check('single connection keeps legacy URI', defsSingle[0].uri, 'mssql://tbl_solo/data');

	const read3 = await MssqlResources.handleResource('mssql://rb/sometable/data', multiRegistry);
	checkContains('3-segment URI reads named connection', read3.text as string, 'c');
	const read2 = await MssqlResources.handleResource('mssql://sometable/data', multiRegistry);
	checkContains('2-segment URI reads default connection', read2.text as string, 'c');

	const failPool: any = { name: 'down', query: async () => { throw new Error('unreachable'); } };
	const mixedRegistry: any = { list: () => [info('up', true), info('down', false)], get: (n?: string) => (n === 'down' ? failPool : tPool('up')) };
	const defsMixed = await MssqlResources.getResourceDefinitions(mixedRegistry);
	check('unreachable connection skipped, healthy one listed', defsMixed.length, 1);
}
```

- [ ] **Step 2: Run to verify failure** — `npm run test:operations` → FAIL (getResourceDefinitions receives registry, current code calls `.query` on it).

- [ ] **Step 3: Rewrite `src/MssqlResources.ts`** (complete file):

```ts
import type { Resource, TextResourceContents } from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import { validateTableName } from './server/config.js';
import type { ConnectionPool } from './server/connection.js';
import type { ConnectionRegistry } from './server/ConnectionRegistry.js';
import { formatCSV } from './utils/csv.js';

const logger = consola.withTag('mssql-resources');

// PERFORMANCE: TTL-based cache for resource listing (5 minutes), one entry per connection
interface ResourceCache {
	resources: Resource[];
	timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const resourceCaches = new Map<string, ResourceCache>();

// PERFORMANCE: Configurable resource data limit from environment
const RESOURCE_DATA_LIMIT = parseInt(process.env.MSSQL_RESOURCE_LIMIT || '100', 10);

async function listTablesFor(pool: ConnectionPool, connectionName: string, multi: boolean): Promise<Resource[]> {
	const now = Date.now();
	const cached = resourceCaches.get(connectionName);
	if (cached && now - cached.timestamp < CACHE_TTL_MS) {
		if (consola.level >= 0) {
			logger.debug(`Returning cached resources for ${connectionName} (age: ${Math.round((now - cached.timestamp) / 1000)}s)`);
		}
		return cached.resources;
	}

	try {
		const results = await pool.query(`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'`);
		if (consola.level >= 0) {
			logger.info(`Found ${results.length} tables on ${connectionName} (cache updated)`);
		}

		const resources: Resource[] = [];
		for (const table of results) {
			const tableName = table.TABLE_NAME || table.table_name;
			resources.push({
				uri: multi ? `mssql://${connectionName}/${tableName}/data` : `mssql://${tableName}/data`,
				name: multi ? `Table: ${connectionName}/${tableName}` : `Table: ${tableName}`,
				mimeType: 'text/plain',
				description: multi ? `Data in table ${tableName} (connection: ${connectionName})` : `Data in table: ${tableName}`,
			});
		}

		resourceCaches.set(connectionName, { resources, timestamp: now });
		return resources;
	} catch (error) {
		if (consola.level >= 0) {
			logger.error(`Failed to list resources for ${connectionName}:`, error);
		}
		// Per-connection error isolation: stale cache if present, else skip this connection
		if (cached) {
			if (consola.level >= 0) logger.warn(`Returning stale cache for ${connectionName} due to error`);
			return cached.resources;
		}
		return [];
	}
}

export const MssqlResources = {
	async getResourceDefinitions(registry: ConnectionRegistry): Promise<Resource[]> {
		const infos = registry.list();
		const multi = infos.length > 1;
		const all: Resource[] = [];
		for (const info of infos) {
			all.push(...(await listTablesFor(registry.get(info.name), info.name, multi)));
		}
		return all;
	},

	async handleResource(uri: string, registry: ConnectionRegistry): Promise<TextResourceContents> {
		// Only log if not in STDIO mode
		if (consola.level >= 0) {
			logger.info(`Reading resource: ${uri}`);
		}

		if (!uri.startsWith('mssql://')) {
			throw new Error(`Invalid URI scheme: ${uri}`);
		}

		const uriPath = uri.substring(8); // Remove 'mssql://' prefix
		const parts = uriPath.split('/');

		let connectionName: string | undefined;
		let tableName: string;
		if (parts.length === 3 && parts[2] === 'data') {
			// mssql://{connection}/{table}/data
			connectionName = parts[0];
			tableName = parts[1];
		} else if (parts.length === 2 && parts[1] === 'data') {
			// legacy mssql://{table}/data → default connection
			tableName = parts[0];
		} else {
			throw new Error(`Invalid URI format: ${uri}. Expected mssql://{table}/data or mssql://{connection}/{table}/data.`);
		}

		if (!tableName) {
			throw new Error(`Invalid URI format: ${uri}`);
		}

		const pool = registry.get(connectionName); // throws a clear error on unknown connection

		try {
			// Validate table name to prevent SQL injection
			const safeTableName = validateTableName(tableName);

			// PERFORMANCE: Use configurable limit for resource data
			const results = await pool.query(`SELECT TOP ${RESOURCE_DATA_LIMIT} * FROM ${safeTableName}`);

			if (results.length === 0) {
				return {
					uri,
					mimeType: 'text/plain',
					text: `No data found in table: ${tableName}`,
				};
			}

			// PERFORMANCE: Memory-efficient CSV formatting with proper escaping
			let paginationWarning = '';
			if (results.length === RESOURCE_DATA_LIMIT) {
				paginationWarning = `\n\n⚠️ Note: Showing first ${RESOURCE_DATA_LIMIT} rows only. Set MSSQL_RESOURCE_LIMIT environment variable to adjust.`;
			}

			const resultText = formatCSV(results, paginationWarning);

			return {
				uri,
				mimeType: 'text/plain',
				text: resultText,
			};
		} catch (error) {
			// PERFORMANCE: Avoid string interpolation in error logging
			if (consola.level >= 0) {
				logger.error('Database error reading resource:', uri, error);
			}
			throw new Error(`Database error: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	},

	clearCaches(connectionName?: string): number {
		if (!connectionName) {
			const n = resourceCaches.size;
			resourceCaches.clear();
			return n;
		}
		return resourceCaches.delete(connectionName) ? 1 : 0;
	},
};
```

(Note: `clearCaches` here keys by BARE connection name — layer-internal, not the `::` namespace format.)

- [ ] **Step 4: Update `src/server/MssqlMcpServer.ts`** — in the ListResources handler change `MssqlResources.getResourceDefinitions(this.registry.get())` to `MssqlResources.getResourceDefinitions(this.registry)`, and in ReadResource change `MssqlResources.handleResource(uri, this.registry.get())` to `MssqlResources.handleResource(uri, this.registry)`.

- [ ] **Step 5: Run tests** — `npm run test:operations` PASS; `npm test` green.

- [ ] **Step 6: Commit**

```bash
git add src/MssqlResources.ts src/server/MssqlMcpServer.ts src/tests/operations.test.ts
git commit -m "feat(resources): multi-connection resource listing/reading with per-connection cache and legacy URI compatibility"
```

---

### Task 7: Documentation + bundle rebuild

**Files:**
- Modify: `CLAUDE.md`, `README.md`
- Rebuild: `dist/main.mjs` (`npm run build` — never hand-edit)

No TDD cycle (docs + build artifact); verification is grep + full test run.

- [ ] **Step 1: Update CLAUDE.md** — precise edits:

1. **Testing section**: command list gains `npm run test:performance-tools   # Performance tools (missing indexes, query plan, top queries) tests` and `npm run test:operations          # Timeout, token efficiency, clear_cache, resources multi-connection tests`; change "Run all 7 test suites sequentially" → "Run all 9 test suites sequentially".
2. **Architecture** — add a new layer subsection after 2c (Profiling Tools):

```markdown
2d. **Performance Tools Layer** ([src/MssqlPerformanceTools.ts](src/MssqlPerformanceTools.ts))
   - Performance-diagnostic tools, all read-only
   - Three tools:
     - `get_missing_indexes`: missing-index suggestions from `sys.dm_db_missing_index_*` DMVs (TOP 25 by improvement measure). Optional `database_name`/`table_name` filters — table filtering matches the DMV `statement` column with an escaped LIKE suffix (never `OBJECT_ID`, which silently NULLs on dotted DB names). Requires `VIEW SERVER STATE`; degrades to a friendly GRANT hint. Cached 5 min (`MSSQL_MISSING_INDEXES_CACHE_TTL`/`_SIZE`)
     - `get_query_plan`: ESTIMATED execution plan (`SET SHOWPLAN_XML ON`) — the query is validated by `isReadOnlyQuery()` first and NEVER executed. Runs on a dedicated ephemeral connection (`createEphemeralConnection` on `ResilientConnectionPool`, pool max 1, closed in `finally`) so SHOWPLAN state can never poison the shared pool. `database_name` opens the ephemeral connection directly in that DB. Requires `SHOWPLAN` permission; friendly diagnostic when missing. Plans capped at 100,000 chars. Not cached
     - `get_top_queries`: heaviest queries from the plan cache (`sys.dm_exec_query_stats` + `dm_exec_sql_text`): execution count, total/avg elapsed ms, CPU ms, logical reads. `sort_by` enum → SQL expression via a lookup map (never raw interpolation); `top` 1-50. Requires `VIEW SERVER STATE`. Not cached (live diagnostic)
```

3. **Routing** (Data Flow section): update the dispatch order sentence to `MssqlObjectTools.canHandle(name)` → `MssqlServerTools.canHandle(name)` → `MssqlProfilingTools.canHandle(name)` → `MssqlPerformanceTools.canHandle(name)` → fallback `MssqlTools.handleTool()`; "concatenating all four providers'" → "all five providers'".
4. **MssqlServerTools section**: "Five tools" → "Six tools"; add `clear_cache` bullet: clears every layer's caches via their `clearCaches(connectionName?)` exports, optional connection filter, executes no SQL.
5. **exec_sql_csv mentions**: note new optional `timeout_seconds` (1-300 s; default `MSSQL_REQUEST_TIMEOUT` 30 s, enforced by a cancel-timer — driver `requestTimeout` is only a 300 s backstop) and `max_rows` (post-fetch row cap, token saver) params; cell truncation via `MSSQL_MAX_CELL_CHARS` (default 1000, 0=off) applies to exec_sql_csv and get_table_sample only, marker `...[truncated N chars]`; cache key now includes max_rows + cell setting.
6. **Resources section**: single connection → legacy `mssql://{table}/data` unchanged; multiple connections → `mssql://{connection}/{table}/data`, reads accept both, per-connection 5-min cache with per-connection error isolation.
7. **Environment Variables**: add `MSSQL_REQUEST_TIMEOUT` (default 30000 ms; per-call override `timeout_seconds`, hard cap 300 s), `MSSQL_MAX_CELL_CHARS` (default 1000; 0 disables), `MSSQL_MISSING_INDEXES_CACHE_TTL` (default 300000) + `MSSQL_MISSING_INDEXES_CACHE_SIZE` (default 50), and the flat suffix `REQUEST_TIMEOUT` in the multi-connection field list.
8. **Tool count**: update any "23 tools" mention to 27.

- [ ] **Step 2: Update README.md** — add the four new tools to the tool list with one-line descriptions, the new env vars to the configuration table, and the `timeout_seconds`/`max_rows` params under exec_sql_csv.

- [ ] **Step 3: Full verification**

```bash
npm test          # 9 suites green
npm run build     # rebuild dist/main.mjs
grep -c "get_missing_indexes\|get_query_plan\|get_top_queries\|clear_cache" dist/main.mjs   # > 0
grep -c "timeout_seconds\|max_rows\|MSSQL_MAX_CELL_CHARS\|MSSQL_REQUEST_TIMEOUT" dist/main.mjs  # > 0
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md dist/main.mjs
git commit -m "docs+build: document performance & operations tools (27 tools), rebuild bundle"
```

---

## Post-plan notes (for the controller, not the implementers)

- Live smoke test (manual, after MCP reload, recorded in the ledger): real SHOWPLAN round-trip via `get_query_plan`; `get_missing_indexes` on AYTONLINE (VIEW SERVER STATE availability unknown); a `timeout_seconds=1` run against a slow query; `clear_cache` then a fresh `get_table_schema`.
- The global rule file `~/.claude/rules/mssql-mcp.md` (outside the repo) needs a 27-tool update — ask the user at finishing time, as with Paket A.
