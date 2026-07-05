# get_object_definition Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `get_object_definition` MCP tool that returns the full SQL body (source code) of a stored procedure, view, function, or trigger, with NULL-safe diagnostics.

**Architecture:** One new handler method (`handleGetObjectDefinition`) inside the existing `src/MssqlObjectTools.ts`, modeled on `handleListProcedures`. It reuses existing infrastructure — `parseObjectName`, `resolveDbScope`, the cache Map pattern, and `paginateLines` / `formatPaginatedResponse` — and needs no changes to `MssqlMcpServer.ts` (routing is automatic via the `TOOL_NAMES` set). Tests are pure-function unit tests using a controlled stub pool (no live DB).

**Tech Stack:** TypeScript (ESM), Zod v4 (`zod/v4`), MCP SDK types, ts-node loader for tests, esbuild for the bundle.

## Global Constraints

- **READ-ONLY only.** The tool issues `SELECT` queries exclusively. Never introduce any write path.
- **SQL injection safety.** Object/schema names come only from `parseObjectName` (regex `^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+){0,2}$`); `database_name` only from `validateDatabaseName`. All SQL literals pass through `escapeLiteral`. Never concatenate raw user input into SQL by any other path.
- **Cross-database via `dbPrefix`.** Use `resolveDbScope(database_name).dbPrefix` on every `sys.*` reference; never rely on `OBJECT_DEFINITION(object_id)` (current-DB only).
- **Cache only successful bodies.** Diagnostic messages (not found / no permission / encrypted / not-a-module) are never cached. Cache stores the full unpaginated definition; pagination is applied after cache read.
- **Follow existing patterns verbatim.** Cache constants, `try/catch` + `errorResponse`, `plainResponse`/`cachedResponse`, Zod parse (unknown keys stripped by default) — mirror `handleListProcedures` exactly.
- **Tests require no live DB.** Use the stub-pool pattern already in `src/tests/object-tools.test.ts`.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/MssqlObjectTools.ts` | Object tools (list_* + new get_object_definition) | Modify — imports, schema, cache, wiring, handler |
| `src/tests/object-tools.test.ts` | Pure-function tests | Modify — registration counts + new branch tests |
| `README.md` | User-facing tool docs | Modify — add tool entry |
| `CLAUDE.md` | Contributor docs | Modify — inventory, remove "not provided" note, add env vars |
| `~/.claude/rules/mssql-mcp.md` | Global rule (OUTSIDE repo) | Do NOT touch — ask user |

---

## Task 1: Implement the `get_object_definition` tool (full handler + tests)

The tool is a single cohesive method. We write all unit tests first (they fail because the tool is not registered), then implement the complete handler so every branch passes.

**Files:**
- Modify: `src/MssqlObjectTools.ts`
- Test: `src/tests/object-tools.test.ts`

**Interfaces:**
- Consumes (existing, already in repo):
  - `parseObjectName(name: string): { database?: string; schema?: string; object: string }` — throws on invalid names — from `./utils/identifier.js`
  - `paginateLines(fullText: string, params: { offset_lines?: number; max_lines?: number }): PaginatedDefinition` and `formatPaginatedResponse(paginated, objectName: string): string` — from `./utils/pagination.js`
  - In-file helpers: `resolveDbScope`, `escapeLiteral`, `getFromCache`, `setInCache`, `plainResponse`, `cachedResponse`, `errorResponse`, `namespaceCacheKey`, `ToolCacheEntry`
- Produces (relied on by tests + routing):
  - New tool name `'get_object_definition'` in `TOOL_NAMES`
  - Method `handleGetObjectDefinition(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }>`
  - `getToolDefinitions()` now returns 5 tools

- [ ] **Step 1: Write the failing tests**

Edit `src/tests/object-tools.test.ts`.

First, add the new tool to the `expectedTools` array (currently lines 37–42) so it becomes:

```ts
const expectedTools = [
	'list_stored_procedures',
	'list_views',
	'list_functions',
	'list_triggers',
	'get_object_definition',
];
```

Then change the definition-count assertion (currently line 60) from `4` to `5`:

```ts
check('exposes 5 tool definitions (4 list tools + get_object_definition)', defs.length, 5);
```

Then add a schema check next to the other `procDef` checks (after line 70):

```ts
const defDef = defs.find((d) => d.name === 'get_object_definition')!;
check('get_object_definition has object_name property', !!(defDef.inputSchema as any).properties?.object_name, true);
check('get_object_definition has connection_name property', !!(defDef.inputSchema as any).properties?.connection_name, true);
```

Finally, append this new test section at the end of the file, just before the final `console.log(\`\n${pass} passed...\`)` block:

```ts
console.log('\n--- get_object_definition branches (controlled stub) ---');

// Stub whose query() returns different rows for the main query vs the
// HAS_PERMS_BY_NAME follow-up query, keyed by SQL content.
function defStub(mainRows: any[], permRows: any[] = []): any {
	return {
		name: 'test',
		query: async (sql: string) => (sql.includes('HAS_PERMS_BY_NAME') ? permRows : mainRows),
	};
}

async function callDef(args: any, stub: any): Promise<string> {
	MssqlObjectTools.clearCachesForTesting();
	const r = await MssqlObjectTools.handleTool('get_object_definition', args, stub);
	return r.content[0]?.type === 'text' ? r.content[0].text : '';
}

// Happy path: definition present -> paginated header + body
{
	const body = 'CREATE PROCEDURE [dbo].[GetUsers]\nAS\nBEGIN\nSELECT 1\nEND';
	const text = await callDef({ object_name: 'dbo.GetUsers' }, defStub([{ type_desc: 'SQL_STORED_PROCEDURE', is_module: 1, definition: body }]));
	checkContains('happy path: paginated header', text, '📄 dbo.GetUsers — lines 1-5 of 5');
	checkContains('happy path: body returned', text, 'CREATE PROCEDURE [dbo].[GetUsers]');
}

// Schema defaults to dbo when object_name has no schema part
{
	const text = await callDef({ object_name: 'GetUsers' }, defStub([{ type_desc: 'SQL_STORED_PROCEDURE', is_module: 1, definition: 'CREATE PROC x AS SELECT 1' }]));
	checkContains('no-schema input defaults to dbo in header', text, '📄 dbo.GetUsers');
}

// Object not found (no rows)
{
	const text = await callDef({ object_name: 'dbo.Missing' }, defStub([]));
	checkContains('not found message', text, 'Object not found: dbo.Missing');
}

// is_module = 0 (a table) -> no SQL definition
{
	const text = await callDef({ object_name: 'dbo.Orders' }, defStub([{ type_desc: 'USER_TABLE', is_module: 0, definition: null }]));
	checkContains('non-module: type in message', text, 'is a USER_TABLE');
	checkContains('non-module: no SQL definition', text, 'no SQL definition');
}

// definition NULL + has_perm = 0 -> permission message
{
	const text = await callDef({ object_name: 'dbo.Hidden' }, defStub([{ type_desc: 'SQL_STORED_PROCEDURE', is_module: 1, definition: null }], [{ has_perm: 0 }]));
	checkContains('null+no-perm: lacks VIEW DEFINITION', text, 'lacks VIEW DEFINITION permission');
}

// definition NULL + has_perm = 1 -> encrypted message
{
	const text = await callDef({ object_name: 'dbo.Encrypted' }, defStub([{ type_desc: 'SQL_STORED_PROCEDURE', is_module: 1, definition: null }], [{ has_perm: 1 }]));
	checkContains('null+has-perm: encrypted', text, 'encrypted (WITH ENCRYPTION)');
}

// Cross-DB (database_name given) + definition NULL -> combined message, HAS_PERMS skipped
{
	const text = await callDef({ object_name: 'dbo.X', database_name: 'OtherDB' }, defStub([{ type_desc: 'SQL_STORED_PROCEDURE', is_module: 1, definition: null }]));
	checkContains('cross-db null: combined message', text, 'lacks VIEW DEFINITION permission, or the object is encrypted');
}

// 3-part object_name rejected with a clear message (parses OK but our policy rejects)
{
	const text = await callDef({ object_name: 'MyDB.dbo.proc' }, defStub([]));
	checkContains('3-part object_name rejected', text, 'has 3 parts');
}

// Invalid object_name (parseObjectName throws) -> clean error
{
	const text = await callDef({ object_name: 'a;drop' }, defStub([]));
	checkContains('invalid object_name: parse error surfaced', text, 'Invalid object name');
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:object-tools`
Expected: FAIL. `defs.length` is still 4 (not 5); `canHandle('get_object_definition')` is false; the branch tests report the tool dispatch throwing `Unknown tool: get_object_definition` (surfaced as thrown error, not the expected content).

- [ ] **Step 3: Add imports, schema, and cache scaffolding**

In `src/MssqlObjectTools.ts`, extend the identifier import (currently line 6) to add `parseObjectName`:

```ts
import { buildCacheKeyPrefix, namespaceCacheKey, parseObjectName, validateDatabaseName } from './utils/identifier.js';
```

Add a new import for pagination directly below the identifier import:

```ts
import { paginateLines, formatPaginatedResponse } from './utils/pagination.js';
```

Add cache constants next to the other cache constants (after line 24, the triggers constants):

```ts
const DEFINITIONS_CACHE_TTL_MS = parseInt(process.env.MSSQL_DEFINITIONS_CACHE_TTL || '7200000', 10);
const DEFINITIONS_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_DEFINITIONS_CACHE_SIZE || '100', 10);
```

Add the cache Map next to the other Maps (after line 29, `triggersCache`):

```ts
const definitionsCache = new Map<string, ToolCacheEntry>();
```

Add the input schema next to the other schemas (after the `ListTriggersInputSchema` block, around line 80):

```ts
const GetObjectDefinitionInputSchema = DatabaseScopeSchema.extend({
	object_name: z.string().describe('Object name as "schema.name" or just "name" (schema defaults to dbo). e.g. "dbo.GetUsers"'),
	offset_lines: z.number().int().optional().describe('Line offset for pagination (default 0)'),
	max_lines: z.number().int().optional().describe('Max lines to return (default 200, hard cap 1000)'),
});
```

- [ ] **Step 4: Register the tool (TOOL_NAMES, getToolDefinitions, handleTool)**

Add to the `TOOL_NAMES` set (currently lines 82–87):

```ts
const TOOL_NAMES = new Set([
	'list_stored_procedures',
	'list_views',
	'list_functions',
	'list_triggers',
	'get_object_definition',
]);
```

Add a definition to the `getToolDefinitions()` return array (after the `list_triggers` entry, around line 155):

```ts
{
	name: 'get_object_definition',
	description: 'Get the full SQL definition (source code) of a stored procedure, view, function, or trigger. Returns NULL-safe diagnostics when the definition is inaccessible (missing VIEW DEFINITION permission), encrypted (WITH ENCRYPTION), or the object is not a code module. Supports cross-database via database_name and line-based pagination.',
	inputSchema: z.toJSONSchema(GetObjectDefinitionInputSchema.extend(ConnectionScopeSchema.shape)) as any,
},
```

Add a case to the `handleTool()` switch (after the `list_triggers` case, around line 168):

```ts
case 'get_object_definition':
	return this.handleGetObjectDefinition(args, pool);
```

- [ ] **Step 5: Implement `handleGetObjectDefinition`**

Add this method after `handleListTriggers` (before `clearCachesForTesting`, around line 296):

```ts
async handleGetObjectDefinition(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
	try {
		const v = GetObjectDefinitionInputSchema.parse(args);
		const parts = parseObjectName(v.object_name);
		if (parts.database) {
			return plainResponse(`Invalid object_name: "${v.object_name}" has 3 parts (database.schema.object). Use the database_name parameter for cross-database access and pass object_name as "schema.name" or "name".`);
		}
		const schema = parts.schema || 'dbo';
		const object = parts.object;
		const scope = resolveDbScope(v.database_name);
		const dbSuffix = v.database_name ? ` in database ${v.database_name}` : '';
		const cacheKey = namespaceCacheKey(pool.name, `${scope.dbCacheKey}${schema}.${object}`);

		const cached = getFromCache(definitionsCache, cacheKey, DEFINITIONS_CACHE_TTL_MS);
		if (cached !== null) {
			const paginated = paginateLines(cached, { offset_lines: v.offset_lines, max_lines: v.max_lines });
			return cachedResponse(formatPaginatedResponse(paginated, `${schema}.${object}`));
		}

		const query = `SELECT o.type_desc, CASE WHEN m.object_id IS NULL THEN 0 ELSE 1 END AS is_module, m.definition AS definition FROM ${scope.dbPrefix}sys.objects o INNER JOIN ${scope.dbPrefix}sys.schemas s ON o.schema_id = s.schema_id LEFT JOIN ${scope.dbPrefix}sys.sql_modules m ON o.object_id = m.object_id WHERE s.name = '${escapeLiteral(schema)}' AND o.name = '${escapeLiteral(object)}'`;

		if (consola.level >= 0) logger.info(`Getting object definition for ${schema}.${object} in ${v.database_name || 'current DB'}`);
		const results = await pool.query(query);

		if (!results || results.length === 0) {
			return plainResponse(`Object not found: ${schema}.${object}${dbSuffix}.`);
		}

		const row: any = results[0];
		if (!row.is_module) {
			return plainResponse(`Object '${schema}.${object}' is a ${row.type_desc}; it has no SQL definition (only stored procedures, views, functions, and triggers do).`);
		}

		if (row.definition == null) {
			if (v.database_name) {
				return plainResponse(`Definition unavailable for '${schema}.${object}'${dbSuffix}: either the connection's login lacks VIEW DEFINITION permission, or the object is encrypted (WITH ENCRYPTION). The cross-database permission check is unreliable, so the exact cause can't be determined here.`);
			}
			const permQuery = `SELECT HAS_PERMS_BY_NAME('${escapeLiteral(schema)}.${escapeLiteral(object)}','OBJECT','VIEW DEFINITION') AS has_perm`;
			const permResults = await pool.query(permQuery);
			const hasPerm = permResults && permResults.length > 0 ? permResults[0].has_perm : 0;
			if (!hasPerm) {
				return plainResponse(`Definition hidden: the connection's login lacks VIEW DEFINITION permission on '${schema}.${object}'. Ask a DBA to GRANT VIEW DEFINITION.`);
			}
			return plainResponse(`Definition is encrypted (WITH ENCRYPTION) and cannot be read.`);
		}

		const definition: string = row.definition;
		setInCache(definitionsCache, cacheKey, definition, DEFINITIONS_CACHE_MAX_SIZE, 'get_object_definition');
		const paginated = paginateLines(definition, { offset_lines: v.offset_lines, max_lines: v.max_lines });
		return plainResponse(formatPaginatedResponse(paginated, `${schema}.${object}`));
	} catch (error) {
		if (consola.level >= 0) logger.error('get_object_definition error:', error);
		return errorResponse('Error getting object definition', error);
	}
}
```

Then add `definitionsCache.clear();` inside `clearCachesForTesting()` (currently lines 298–303):

```ts
clearCachesForTesting(): void {
	procsCache.clear();
	viewsCache.clear();
	functionsCache.clear();
	triggersCache.clear();
	definitionsCache.clear();
},
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:object-tools`
Expected: PASS. All branch tests green; `defs.length` is 5; `canHandle('get_object_definition')` is true.

- [ ] **Step 7: Run the full suite to check for regressions**

Run: `npm test`
Expected: All 5 suites pass (errors, identifiers, object-tools, server-tools, profiling-tools).

- [ ] **Step 8: Commit**

```bash
git add src/MssqlObjectTools.ts src/tests/object-tools.test.ts
git commit -m "feat(object-tools): add get_object_definition tool with NULL-safe diagnostics"
```

---

## Task 2: Documentation

Update in-repo docs to reflect the new tool and remove now-false "definition retrieval not provided" claims. The global rule file `~/.claude/rules/mssql-mcp.md` is OUTSIDE the repo — do not touch it here; it is handled in Task 3.

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the tool to README.md**

README currently does not list the object tools at all and has no "not exposed" claim. Add a new subsection immediately before `### 📂 Database Resources` (currently line 298):

```markdown
### 🧩 Programmable Object Tools

- **`list_stored_procedures`** / **`list_views`** / **`list_functions`** / **`list_triggers`**: List programmable objects with metadata (schema, name, dates, parameter/event info). All support cross-database queries via the optional `database_name` parameter.

- **`get_object_definition`**: Get the full SQL definition (source code) of a stored procedure, view, function, or trigger
  - Input: `object_name` as `"schema.name"` or just `"name"` (schema defaults to `dbo`)
  - Line-based pagination via `offset_lines` / `max_lines` (default 200 lines, hard cap 1000)
  - Cross-database via `database_name`
  - NULL-safe diagnostics: reports clearly when the object is not a code module, when the login lacks `VIEW DEFINITION` permission, or when the object is encrypted (`WITH ENCRYPTION`)
```

- [ ] **Step 2: Update the CLAUDE.md Object Tools Layer inventory**

In `CLAUDE.md`, change the "Four tools" line (line 377) to "Five tools":

Old:
```
   - Four tools (all accept `database_name` — 1-part validated; default = connection's bound DB):
```
New:
```
   - Five tools (all accept `database_name` — 1-part validated; default = connection's bound DB):
```

Then add a bullet describing the new tool immediately after the `list_triggers` bullet (line 381):

```markdown
     - `get_object_definition`: full SQL body of a stored procedure / view / function / trigger via `sys.sql_modules.definition` (cross-DB safe through `{db}.sys.sql_modules`). NULL-safe: distinguishes "not found", non-module objects (tables), missing `VIEW DEFINITION` permission (via `HAS_PERMS_BY_NAME`, same-DB only), and `WITH ENCRYPTION`. 3-part `object_name` is rejected (use `database_name`). Line-paginated via `paginateLines`. Caches only the successful full body.
```

- [ ] **Step 3: Replace the "not provided" note in CLAUDE.md**

Replace the entire note at line 384. Old:
```
   - **NOTE — definition retrieval intentionally not provided**: Tools like `get_procedure_definition` / `get_object_dependencies` were prototyped (see git history) but removed because they require `VIEW DEFINITION` (or `VIEW ANY DEFINITION`) which read-only users typically lack. The MCP would return only "🔒 permission denied" messages, polluting AI context with no signal. If a future deployment grants those permissions, restore from commit history and re-register in `MssqlMcpServer.ts`
```
New:
```
   - **NOTE — definition retrieval is provided by `get_object_definition`** (a single generic tool for all module types). It requires `VIEW DEFINITION` (object/schema-level grant is enough — server-wide `VIEW ANY DEFINITION` is not needed). When the permission is missing, the tool returns a clear NULL-safe diagnostic rather than a raw error. Per-type definition tools (`get_procedure_definition`, `get_object_dependencies`) remain intentionally absent — the one generic tool covers procedures, views, functions, and triggers.
```

- [ ] **Step 4: Update the pagination "unused" note in CLAUDE.md**

Replace the note at line 552. Old:
```
- The pagination utility in [src/utils/pagination.ts](src/utils/pagination.ts) reads these env vars but is currently **unused** — definition retrieval tools were removed (see Object Tools Layer note above). The utility is retained for future re-introduction if `VIEW DEFINITION` permission becomes available
```
New:
```
- The pagination utility in [src/utils/pagination.ts](src/utils/pagination.ts) is used by `get_object_definition` to paginate large SQL bodies. `MSSQL_DEFINITION_DEFAULT_LINES` (default 200) and `MSSQL_DEFINITION_MAX_LINES` (hard cap 1000) tune the line window.
```

- [ ] **Step 5: Add the new cache env vars to CLAUDE.md**

In the "Object Tools Caching" list, immediately after the `MSSQL_TRIGGERS_CACHE_TTL` line (line 570), add:

```markdown
- `MSSQL_DEFINITIONS_CACHE_TTL` / `MSSQL_DEFINITIONS_CACHE_SIZE`: get_object_definition (defaults: 2h / 100) — caches only successfully-retrieved full definitions; diagnostics are never cached
```

- [ ] **Step 6: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document get_object_definition tool"
```

---

## Task 3: Build, live verification, and global-rule prompt

**Files:**
- Modify: `dist/main.mjs` (generated by build)

- [ ] **Step 1: Build the bundle**

Run: `npm run build`
Expected: esbuild completes, reports bundle size (~4 MB), `dist/main.mjs` regenerated with no errors.

- [ ] **Step 2: Run the full test suite once more against the built state**

Run: `npm test`
Expected: All 5 suites pass.

- [ ] **Step 3: Live verification (requires MCP reload)**

The consumer `.mcp.json` runs `dist/main.mjs --stdio`; the new tool only appears after the MCP server/session is reloaded. After reload, verify via the MSSQL MCP tools (not raw sqlcmd):
- On the `crm` connection, call `get_object_definition` with `object_name="dbo.GetCityAndCountyCodes"`. Expected: a `📄 dbo.GetCityAndCountyCodes — lines 1-N of N` header followed by the real body (`CREATE PROCEDURE ...`, ~356 characters).
- Call with a non-existent object (e.g. `object_name="dbo.NoSuchThing"`). Expected: `Object not found: dbo.NoSuchThing.`
- Call with a table name (e.g. any base table). Expected: `... is a USER_TABLE; it has no SQL definition ...`

If reload cannot be performed in this session, note it and hand the live checks to the user with the exact calls above.

- [ ] **Step 4: Commit the rebuilt bundle**

```bash
git add dist/main.mjs
git commit -m "build: rebuild bundle with get_object_definition tool"
```

- [ ] **Step 5: Ask the user about the global rule (do NOT edit it automatically)**

The global rule `~/.claude/rules/mssql-mcp.md` (outside this repo, applies to all projects) still says definition retrieval is "intentionally not exposed / Don't ask for it." Ask the user:

> "`get_object_definition` artık mevcut. Küresel kural dosyan `~/.claude/rules/mssql-mcp.md` hâlâ 'definition retrieval intentionally not exposed... Don't ask for it' diyor. Bu dosya tüm projelerine ait — güncelleyeyim mi?"

Do not modify that file unless the user says yes.

---

## Self-Review

**1. Spec coverage:**
- Purpose / single generic tool → Task 1 (getToolDefinitions + handler). ✓
- Input schema (object_name / offset_lines / max_lines / database_name / connection_name) → Task 1 Step 3–4. ✓
- Single cross-DB-safe query via dbPrefix → Task 1 Step 5. ✓
- NULL-parse branches (not found / is_module=0 / null+perm / null+encrypted / cross-DB combined) → Task 1 Step 5 + tests Step 1. ✓
- 3-part rejection + invalid-name handling → Task 1 Step 5 (guard) + tests. ✓
- Cache: only successful body, namespaced key, paginate-after-read, clearCachesForTesting → Task 1 Step 3/5. ✓
- Wiring without MssqlMcpServer changes → Task 1 Step 4 (TOOL_NAMES auto-routes). ✓
- Test strategy (stub pool, all branches, count 4→5, remove from removedTools) → Task 1. Note: `get_object_definition` is NOT in the existing `removedTools` list, so no removal edit is needed — only the additions above. ✓
- Docs (README + CLAUDE.md; global rule ask) → Task 2 + Task 3 Step 5. ✓
- Build + live verification checklist → Task 3. ✓

**2. Placeholder scan:** No TBD/TODO; all code and commands are concrete. ✓

**3. Type consistency:** `handleGetObjectDefinition` signature matches the `handleTool` case and the Produces block. `row.is_module` / `row.definition` / `row.type_desc` match the SELECT aliases. `permResults[0].has_perm` matches the HAS_PERMS alias. `defStub` returns `{ name, query }` — `pool.name` is read in the handler for the cache key, so the stub sets `name: 'test'`. Cache constant names (`DEFINITIONS_CACHE_TTL_MS` / `DEFINITIONS_CACHE_MAX_SIZE`) are used consistently. ✓
