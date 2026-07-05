# Performance & Operations Tools (Paket B + C) — Design Spec

Date: 2026-07-05
Status: Approved by user (design sections 1-3 approved in brainstorming session)
Predecessor: 2026-07-05-discovery-tools-design.md (Paket A, merged as 4f60eb4)

## Goal

Add three performance-diagnostic tools (Paket B) and four operational improvements
(Paket C) to the read-only MSSQL MCP server. Tool count goes 23 → 27.

**Paket B (new layer `src/MssqlPerformanceTools.ts`):**
1. `get_missing_indexes` — missing-index suggestions from server DMVs
2. `get_query_plan` — estimated execution plan (SHOWPLAN_XML, query never runs)
3. `get_top_queries` — heaviest queries from the plan cache (real runtime stats)

**Paket C (embedded in existing layers):**
4. Query timeout — `MSSQL_REQUEST_TIMEOUT` env default (30 s) + per-call `timeout_seconds` on `exec_sql_csv`
5. `clear_cache` tool — clears all tool caches, optional `connection_name` filter (added to MssqlServerTools)
6. Resources multi-connection — `mssql://{connection}/{table}/data` URIs when multiple connections configured
7. Token efficiency — long-cell truncation + `max_rows` param on `exec_sql_csv`

## Architecture (Approach 1 — approved)

New performance layer follows the proven provider pattern (`canHandle` /
`getToolDefinitions` / `handleTool`); server routing chain gains one branch.
Paket C items are embedded where they naturally live:

| Item | Files |
|---|---|
| Paket B tools | `src/MssqlPerformanceTools.ts` (new), `src/server/MssqlMcpServer.ts` (route) |
| Timeout | `src/server/config.ts`, `src/server/connection.ts`, `src/MssqlTools.ts` (param) |
| clear_cache | all 4 tool layers + `MssqlResources.ts` (export `clearCaches`), tool def in `src/MssqlServerTools.ts` |
| Resources multi-conn | `src/MssqlResources.ts`, `src/server/MssqlMcpServer.ts` |
| Token efficiency | `src/utils/csv.ts`, `src/MssqlTools.ts`, `src/MssqlProfilingTools.ts` (sample) |

Import direction for clear_cache: `MssqlServerTools` imports `clearCaches` from the
other layers; no layer imports MssqlServerTools → no import cycle.

## Global Constraints (binding)

- Server stays **READ-ONLY by design**. No tool executes user SQL outside the
  existing validation path. `clear_cache` executes **no SQL at all**.
- `get_query_plan` runs the candidate query through `isReadOnlyQuery()` BEFORE
  any connection is opened (defense in depth — the query never executes, but the
  same multi-layer validation applies). Blocked keywords (`UNION`, `EXEC`, …)
  are therefore also rejected for planning; this limitation is documented in the
  tool description.
- User-supplied text reaches SQL only as: quote-doubled string literals
  (`escapeLiteral`), LIKE-escaped literals (`escapeLikePattern`, `ESCAPE '\'`),
  validated identifiers (`validateObjectName` / `validateDatabaseName`), or
  values from **enum-keyed lookup maps** (never raw interpolation).
- All string literals carrying user text are N-prefixed (Unicode, Paket A lesson).
- Never use `OBJECT_ID('db.schema.obj')` with an interpolated 3-/4-part name
  (dotted DB names silently return NULL — live-verified Paket A bug). For
  missing-index table filtering use the DMV's own `statement` column instead.
- Single-line SQL template literals, TAB indentation, `consola.level >= 0` log
  guards, conventional commits — match existing code style.
- Cache keys namespaced per connection via the existing namespace util; new
  caches use the same lazy-TTL + true-LRU pattern.
- `dist/main.mjs` is a committed, deployed artifact: rebuild with `npm run build`
  at the end and grep-verify new tool names; never hand-edit or hand-merge it.
- Backward compatibility: existing tool calls, env configs, and single-connection
  resource URIs keep working unchanged.

---

## 1. Paket B — `src/MssqlPerformanceTools.ts`

### 1.1 `get_missing_indexes`

**Input** (Zod): `database_name?` (validateDatabaseName), `table_name?`
(1- or 2-part, validated via parseObjectName; 3-part rejected — use
`database_name`), `connection_name?`.

**Query** (single line in code; shown wrapped here):

```sql
SELECT TOP 25
  mid.statement AS [table],
  mid.equality_columns, mid.inequality_columns, mid.included_columns,
  CAST(migs.avg_user_impact AS DECIMAL(5,1)) AS avg_user_impact_pct,
  migs.user_seeks, migs.user_scans,
  CAST(migs.avg_total_user_cost AS DECIMAL(12,2)) AS avg_total_user_cost,
  CONVERT(VARCHAR(19), migs.last_user_seek, 120) AS last_user_seek,
  CAST(migs.avg_user_impact * (migs.user_seeks + migs.user_scans) * migs.avg_total_user_cost AS DECIMAL(18,2)) AS improvement_measure
FROM sys.dm_db_missing_index_details mid
INNER JOIN sys.dm_db_missing_index_groups mig ON mig.index_handle = mid.index_handle
INNER JOIN sys.dm_db_missing_index_group_stats migs ON migs.group_handle = mig.index_group_handle
WHERE mid.database_id = {dbFilter}
  [AND mid.statement LIKE N'%.{escapedSchemaTablePattern}' ESCAPE '\']
ORDER BY improvement_measure DESC
```

- `{dbFilter}`: `DB_ID()` when `database_name` omitted; `DB_ID(N'<escaped>')`
  when provided (escapeLiteral).
- Table filter: build the bracketed suffix `[schema].[table]` from validated
  parts, LIKE-escape it with `escapeLikePattern` (brackets are LIKE wildcards),
  match as suffix. Combined with the `database_id` equality this is unambiguous.
  **No OBJECT_ID.**
- **Permission handling**: DMV access needs `VIEW SERVER STATE`. Catch errors whose
  message contains `permission` or `VIEW SERVER STATE` → return friendly
  diagnostic (same pattern as `get_server_info`): explain the missing grant
  (`GRANT VIEW SERVER STATE TO <login>;`) instead of failing.
- **Output notes** (always appended): suggestions reset on server restart; they
  are hints — no dedup against existing indexes; column order within a
  suggested index matters and is not encoded here.
- **Cache**: `missingIndexesCache`, TTL `MSSQL_MISSING_INDEXES_CACHE_TTL`
  (default 300,000 ms = 5 min), size `MSSQL_MISSING_INDEXES_CACHE_SIZE`
  (default 50), lazy-TTL + LRU, connection-namespaced keys including
  database/table filters.

### 1.2 `get_query_plan`

**Input** (Zod): `query` (min 1), `database_name?` (validateDatabaseName),
`connection_name?`.

**Flow:**
1. `isReadOnlyQuery(query)` — on failure, same rejection message as `exec_sql_csv`.
2. Obtain an **ephemeral dedicated connection** from the pool object (see 1.2a).
   `database_name`, when given, is applied as the ephemeral connection's
   `database` (native cross-DB, no `USE` needed).
3. `batch('SET SHOWPLAN_XML ON')` on that connection.
4. Send the query on the same connection — the server returns the XML plan
   instead of executing. Plan text = first column of first row
   (`Object.values(recordset[0])[0]`).
5. `finally`: close the ephemeral connection (no `SET ... OFF` needed — the
   connection dies; **pool poisoning is structurally impossible**).
6. Truncate plan text at 100,000 chars (constant, no env — YAGNI) with an
   explicit `...[truncated]` note.

**1.2a Connection surface**: `ConnectionPool` interface gains an optional method:

```ts
createEphemeralConnection?(databaseOverride?: string): Promise<{
  batch(sql: string): Promise<void>;
  query<T = any>(sql: string): Promise<T[]>;
  close(): Promise<void>;
}>;
```

`ResilientConnectionPool` implements it by building a one-off
`sql.ConnectionPool` (pool `{ max: 1, min: 0 }`) from its stored config, with
`database` overridden when requested. The handler duck-checks the method and
returns a clear "not supported by this pool" error if absent (keeps fakes and
the deprecated legacy pool honest). Test fakes implement the same shape.

**Errors**: message contains `SHOWPLAN permission denied` → friendly diagnostic
(`GRANT SHOWPLAN TO <login>;` hint). Syntax/schema errors surface as-is.
Connection failure → existing friendly unavailable message.

**Not cached** (diagnostic; stale plans mislead).

### 1.3 `get_top_queries`

**Input** (Zod): `sort_by?` enum `avg_elapsed` (default) | `total_elapsed` |
`cpu` | `reads` | `executions`; `top?` int 1–50 (default 20);
`database_name?`; `connection_name?`.

**Query** (single line in code):

```sql
SELECT TOP {top}
  REPLACE(REPLACE(REPLACE(SUBSTRING(st.text, 1, 200), CHAR(13), ' '), CHAR(10), ' '), CHAR(9), ' ') AS query_text,
  DB_NAME(st.dbid) AS database_name,
  qs.execution_count,
  CAST(qs.total_elapsed_time / 1000.0 AS DECIMAL(18,1)) AS total_elapsed_ms,
  CAST(qs.total_elapsed_time / qs.execution_count / 1000.0 AS DECIMAL(18,1)) AS avg_elapsed_ms,
  CAST(qs.total_worker_time / 1000.0 AS DECIMAL(18,1)) AS total_cpu_ms,
  qs.total_logical_reads,
  qs.total_logical_reads / qs.execution_count AS avg_logical_reads,
  CONVERT(VARCHAR(19), qs.last_execution_time, 120) AS last_execution
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
[WHERE st.dbid = DB_ID(N'<escaped>')]
ORDER BY {sortExpr} DESC
```

- `{sortExpr}` from an **enum-keyed map** (no user text):
  `avg_elapsed` → `qs.total_elapsed_time / qs.execution_count`,
  `total_elapsed` → `qs.total_elapsed_time`, `cpu` → `qs.total_worker_time`,
  `reads` → `qs.total_logical_reads`, `executions` → `qs.execution_count`.
- `{top}` comes from Zod-validated integer — safe to interpolate.
- Times are microseconds in the DMV → divided to ms.
- **Notes appended**: stats reset on restart / plan eviction; `database_name`
  filter excludes ad-hoc queries whose `dbid` is NULL (note shown when filter
  used); pair with `get_query_plan` to inspect a specific query's plan.
- **Permission**: `VIEW SERVER STATE`, same friendly degradation as 1.1.
- **Not cached** (live diagnostic data).

---

## 2. Paket C

### 2.1 Query timeout

**Config** (`src/server/config.ts`):
- `MssqlConfig` gains `requestTimeout?: number` (ms).
- Sources: `MSSQL_REQUEST_TIMEOUT` (legacy/global), flat
  `MSSQL_CONN_<name>_REQUEST_TIMEOUT` (new recognized suffix — matched before
  shorter suffixes like the existing `WINDOWS_AUTH` handling), JSON blob field
  `requestTimeout`. Parsed as integer ms. Default 30,000.

**Driver interplay (the subtle part, decided at design time):** the mssql
driver's `requestTimeout` is pool-wide; a per-call value LARGER than it would
never fire. Therefore:
- `buildMssqlConfig` sets the driver `requestTimeout` to
  `max(300_000, config.requestTimeout ?? 0)` — a backstop, not the effective
  timeout (the `max` keeps a user-configured global timeout above 300 s working;
  only the per-call param is capped at 300 s by Zod).
- The **effective timeout is always enforced by our own cancel-timer** in
  `ResilientConnectionPool.query()`: `effectiveMs = options?.timeoutMs ??
  config.requestTimeout ?? 30_000`. A `setTimeout` fires `request.cancel()`;
  the timer is cleared in `finally` (no leaks). Consistent friendly error for
  every timeout: "Query exceeded the N-second timeout and was cancelled. Use
  timeout_seconds to allow more time (max 300)."
- Cancellation errors (driver code `ECANCEL` / message `Canceled.`) are
  detected via a local `timedOut` flag checked BEFORE `isConnectionError` —
  a cancel must never trigger the reconnect cycle.

**Interface**: `ConnectionPool.query(sqlQuery, options?: { timeoutMs?: number })`
— optional second param, all existing callers unchanged.

**Tool param**: `exec_sql_csv` gains `timeout_seconds?` (Zod int 1–300).

### 2.2 Token efficiency

**Cell truncation** (`src/utils/csv.ts`):
- `formatCSV(results, warning = '', maxCellChars?: number)`. When
  `maxCellChars > 0` and a cell's string form exceeds it:
  `value.slice(0, maxCellChars) + '...[truncated ' + omitted + ' chars]'`.
  Truncation happens BEFORE `escapeCSVCell` so the marker stays readable.
- Env `MSSQL_MAX_CELL_CHARS` (default 1000; `0` disables).
- Applied ONLY by `exec_sql_csv` and `get_table_sample` (they pass the env
  value). All other callers omit the param → behavior unchanged.

**`max_rows` param** (`exec_sql_csv`, Zod int min 1):
- Effective limit `min(max_rows, MSSQL_MAX_ROWS)`. Applied post-fetch by
  slicing; when sliced, append note: `Showing first {n} of {fetched} fetched
  rows (max_rows). Use TOP in your SQL to also reduce database work.`
- Tool description documents that this saves tokens, not database work.

**Cache correctness**: the `exec_sql_csv` result-cache key now includes
`max_rows` and the truncation setting (append `|max_rows=<n>|cell=<c>` to the
normalized text before SHA256) — a 20-row view and a full view never collide.
`timeout_seconds` is deliberately NOT in the key (same data either way).

### 2.3 `clear_cache` (tool lives in MssqlServerTools)

- Each layer exports `clearCaches(connectionName?: string): number` (entries
  removed): `MssqlTools`, `MssqlObjectTools`, `MssqlServerTools`,
  `MssqlProfilingTools`, `MssqlResources`.
  - No arg → clear every cache fully (including the static version cache).
  - With arg → delete only entries whose key carries that connection's
    namespace prefix (exact prefix format read from the existing namespace
    util at implementation time).
- Tool input: `connection_name?` — here it selects **whose entries to clear**;
  the tool performs **no database access**.
- Output CSV: `layer,entries_cleared` rows + total + note "first queries after
  clearing will be slower while caches repopulate".

### 2.4 Resources multi-connection

- **Single connection configured → zero change**: URIs stay
  `mssql://{table}/data` (backward compatible).
- **Multiple connections** → listing enumerates every connection; URIs become
  `mssql://{connection}/{table}/data`.
- `handleResource` accepts both forms: 2 path segments → default connection;
  3 segments → named connection (unknown name → clear error).
- Resource list cache becomes `Map<connectionName, {resources, timestamp}>`
  (5 min TTL as today). Per-connection error isolation: an unreachable
  connection contributes its stale cache if present, else is skipped with a
  log; other connections still list.
- Signatures change to accept the server's pool registry + default name
  (exact registry type read from MssqlMcpServer at implementation time).
- Listing runs per-connection attempts in parallel (`Promise.allSettled`)
  instead of serially, so one slow/unreachable connection no longer stalls
  the others. Connections with no stale cache to fall back on are
  negative-cached for 60 s after a failed attempt, so repeated re-listings
  (e.g. the 5-minute resource-list refresh) don't re-stall on the same
  down connection every time.

---

## 3. Wiring

- `MssqlMcpServer`: routing order becomes ObjectTools → ServerTools →
  ProfilingTools → **PerformanceTools** → fallback MssqlTools. Tool list =
  concatenation of five providers.
- Tool count **23 → 27** (`get_missing_indexes`, `get_query_plan`,
  `get_top_queries`, `clear_cache`).

### New environment variables

| Var | Default | Meaning |
|---|---|---|
| `MSSQL_REQUEST_TIMEOUT` | 30000 | Effective query timeout, ms (hard cap 300 s per call) |
| `MSSQL_MAX_CELL_CHARS` | 1000 | Cell truncation threshold for exec_sql_csv / get_table_sample; 0 = off |
| `MSSQL_MISSING_INDEXES_CACHE_TTL` | 300000 | get_missing_indexes cache TTL, ms |
| `MSSQL_MISSING_INDEXES_CACHE_SIZE` | 50 | get_missing_indexes cache max entries |

## 4. Tests

Framework-less standalone scripts (existing pattern: fake pools routing on SQL
content markers, `check`/`checkContains` helpers).

**New `src/tests/performance-tools.test.ts`:**
- 3 tool definitions exposed; `canHandle` routing.
- `get_missing_indexes`: SQL contains the three DMV joins; `DB_ID()` vs
  `DB_ID(N'...')`; table filter via `statement LIKE` with escaped brackets and
  `ESCAPE '\'` (assert NO `OBJECT_ID(` in the SQL); permission-error → friendly
  message; cache hit (second call, no query).
- `get_query_plan`: rejected write query never reaches the pool (fake
  `createEphemeralConnection` records calls); batch `SET SHOWPLAN_XML ON` sent
  before query; connection `close()` called even when query throws (finally);
  `database_name` passed as override; pool without the method → clear error;
  100k truncation marker.
- `get_top_queries`: enum → sortExpr mapping (spot-check 2), TOP bound (51 →
  Zod rejection), dbid filter only when database_name given, VIEW SERVER STATE
  degradation.

**New `src/tests/operations.test.ts`:**
- Timeout: fake slow query + `timeout_seconds` → cancel path produces the
  friendly timeout message; timer cleared on fast success (no unhandled
  cancel); `timedOut` flag prevents reconnect classification.
- Truncation: >1000-char cell gets marker with omitted count; marker survives
  CSV escaping; `MSSQL_MAX_CELL_CHARS=0` disables; metadata tools unaffected.
- `max_rows`: slicing + note; cache key differs between max_rows values.
- `clear_cache`: populate fake caches across layers → full clear counts;
  connection-filtered clear leaves other connection's entries.
- Resources: URI parsing 2-seg vs 3-seg; unknown connection error;
  single-connection legacy URIs; per-connection cache isolation.

**Updates**: `multi-connection.test.ts` tool count 23 → 27; `package.json`
test chain + `test:performance-tools`, `test:operations` scripts.

**Live smoke (manual, after MCP reload)** — fakes cannot cover: real SHOWPLAN
round-trip on the ephemeral connection; real `request.cancel()` behavior on the
production driver; `VIEW SERVER STATE` availability on AYTONLINE.

## 5. Documentation

- `CLAUDE.md`: new Performance Tools layer section (2d), timeout/truncation/
  max_rows in tool docs, env var tables, test suite count 7 → 9, tool count 27.
- `README.md`: new tools + env vars.
- `~/.claude/rules/mssql-mcp.md` (global rule, OUTSIDE repo — ask user before
  updating, same as Paket A): performance-tool workflow bullets, 27 tools.
- Rebuild `dist/main.mjs`, grep-verify (`get_missing_indexes`,
  `get_query_plan`, `get_top_queries`, `clear_cache`, `timeout_seconds`,
  `max_rows`).

## 6. Out of scope

- Actual-execution plans (running the query for real runtime stats) — read-only
  ethos keeps us on estimated plans + cached-plan stats.
- Index DDL generation (`CREATE INDEX` statements) — write-adjacent output kept
  out; the AI can compose DDL text itself from the returned columns.
- Per-table cache invalidation (YAGNI — rejected in brainstorming).
- Deferred minors from Paket A (tracked in `.superpowers/sdd/progress.md`).
