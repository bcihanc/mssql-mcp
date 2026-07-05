import type { TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import { z } from 'zod/v4';
import type { ConnectionPool } from './server/connection.js';
import { formatCSV } from './utils/csv.js';
import { buildCacheKeyPrefix, namespaceCacheKey, parseObjectName, validateDatabaseName } from './utils/identifier.js';
import { paginateLines, formatPaginatedResponse } from './utils/pagination.js';
import { ConnectionScopeSchema } from './utils/connectionScope.js';

const logger = consola.withTag('mssql-object-tools');

interface ToolCacheEntry {
	result: string;
	timestamp: number;
	lastAccessed: number;
}

const PROCS_CACHE_TTL_MS = parseInt(process.env.MSSQL_PROCS_CACHE_TTL || '7200000', 10);
const PROCS_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_PROCS_CACHE_SIZE || '100', 10);
const VIEWS_CACHE_TTL_MS = parseInt(process.env.MSSQL_VIEWS_CACHE_TTL || '7200000', 10);
const VIEWS_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_VIEWS_CACHE_SIZE || '100', 10);
const FUNCTIONS_CACHE_TTL_MS = parseInt(process.env.MSSQL_FUNCTIONS_CACHE_TTL || '7200000', 10);
const FUNCTIONS_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_FUNCTIONS_CACHE_SIZE || '100', 10);
const TRIGGERS_CACHE_TTL_MS = parseInt(process.env.MSSQL_TRIGGERS_CACHE_TTL || '7200000', 10);
const TRIGGERS_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_TRIGGERS_CACHE_SIZE || '100', 10);
const DEFINITIONS_CACHE_TTL_MS = parseInt(process.env.MSSQL_DEFINITIONS_CACHE_TTL || '7200000', 10);
const DEFINITIONS_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_DEFINITIONS_CACHE_SIZE || '100', 10);

const procsCache = new Map<string, ToolCacheEntry>();
const viewsCache = new Map<string, ToolCacheEntry>();
const functionsCache = new Map<string, ToolCacheEntry>();
const triggersCache = new Map<string, ToolCacheEntry>();
const definitionsCache = new Map<string, ToolCacheEntry>();

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

const DatabaseScopeSchema = z.object({
	database_name: z.string().optional().describe('Optional cross-database scope. If omitted, uses the connection\'s current database. Only alphanumeric and underscore characters allowed.'),
});

const ListProcsInputSchema = DatabaseScopeSchema.extend({
	schema_name: z.string().optional().describe('Optional schema name filter (e.g. "dbo")'),
	include_system: z.boolean().optional().describe('Include system-shipped procedures (default: false)'),
});

const ListViewsInputSchema = ListProcsInputSchema;
const ListFunctionsInputSchema = ListProcsInputSchema;
const ListTriggersInputSchema = DatabaseScopeSchema.extend({
	table_name: z.string().optional().describe('Optional 1-part table name filter (no schema). Lists triggers attached to this table.'),
	include_system: z.boolean().optional().describe('Include system-shipped triggers (default: false)'),
});

const GetObjectDefinitionInputSchema = DatabaseScopeSchema.extend({
	object_name: z.string().describe('Object name as "schema.name" or just "name" (schema defaults to dbo). e.g. "dbo.GetUsers"'),
	offset_lines: z.number().int().optional().describe('Line offset for pagination (default 0)'),
	max_lines: z.number().int().optional().describe('Max lines to return (default 200, hard cap 1000)'),
});

const TOOL_NAMES = new Set([
	'list_stored_procedures',
	'list_views',
	'list_functions',
	'list_triggers',
	'get_object_definition',
]);

interface ResolvedScope {
	dbPrefix: string;
	dbIdExpr: string;
	dbCacheKey: string;
}

function resolveDbScope(databaseName?: string): ResolvedScope {
	if (databaseName) {
		const bracketed = validateDatabaseName(databaseName);
		const safeForLiteral = databaseName.replace(/'/g, "''");
		return {
			dbPrefix: `${bracketed}.`,
			dbIdExpr: `DB_ID('${safeForLiteral}')`,
			dbCacheKey: buildCacheKeyPrefix(databaseName),
		};
	}
	return {
		dbPrefix: '',
		dbIdExpr: 'DB_ID()',
		dbCacheKey: buildCacheKeyPrefix(),
	};
}

function escapeLiteral(s: string): string {
	return s.replace(/'/g, "''");
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

export const MssqlObjectTools = {
	canHandle(name: string): boolean {
		return TOOL_NAMES.has(name);
	},

	getToolDefinitions(): Tool[] {
		return [
			{
				name: 'list_stored_procedures',
				description: 'List all stored procedures with schema, name, parameter count, and create/modify dates. Supports cross-database queries via the optional database_name parameter. Filters out system-shipped procedures by default.',
				inputSchema: z.toJSONSchema(ListProcsInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
			{
				name: 'list_views',
				description: 'List all views with schema, name, and create/modify dates. Supports cross-database queries via the optional database_name parameter. Filters out system-shipped views by default.',
				inputSchema: z.toJSONSchema(ListViewsInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
			{
				name: 'list_functions',
				description: 'List all user-defined functions (scalar, inline TVF, multi-statement TVF, CLR aggregate) with schema, name, type, and create/modify dates. Supports cross-database queries.',
				inputSchema: z.toJSONSchema(ListFunctionsInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
			{
				name: 'list_triggers',
				description: 'List DML triggers with parent table, name, type (INSTEAD OF / AFTER), enabled state, and the events they fire on (INSERT/UPDATE/DELETE). Optionally filter by parent table_name.',
				inputSchema: z.toJSONSchema(ListTriggersInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
			{
				name: 'get_object_definition',
				description: 'Get the full SQL definition (source code) of a stored procedure, view, function, or trigger. Returns NULL-safe diagnostics when the definition is inaccessible (missing VIEW DEFINITION permission), encrypted (WITH ENCRYPTION), or the object is not a code module. Supports cross-database via database_name and line-based pagination.',
				inputSchema: z.toJSONSchema(GetObjectDefinitionInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
		];
	},

	async handleTool(name: string, args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		switch (name) {
			case 'list_stored_procedures':
				return this.handleListProcedures(args, pool);
			case 'list_views':
				return this.handleListViews(args, pool);
			case 'list_functions':
				return this.handleListFunctions(args, pool);
			case 'list_triggers':
				return this.handleListTriggers(args, pool);
			case 'get_object_definition':
				return this.handleGetObjectDefinition(args, pool);
		}
		throw new Error(`Unknown tool: ${name}`);
	},

	async handleListProcedures(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = ListProcsInputSchema.parse(args);
			const scope = resolveDbScope(v.database_name);
			const cacheKey = namespaceCacheKey(pool.name, `${scope.dbCacheKey}${v.schema_name || '_all_'}:${v.include_system ? 'sys' : 'user'}`);

			const cached = getFromCache(procsCache, cacheKey, PROCS_CACHE_TTL_MS);
			if (cached !== null) return cachedResponse(cached);

			const filters: string[] = [];
			if (!v.include_system) filters.push('p.is_ms_shipped = 0');
			if (v.schema_name) filters.push(`s.name = '${escapeLiteral(v.schema_name)}'`);
			const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

			const query = `SELECT s.name AS schema_name, p.name AS proc_name, p.create_date, p.modify_date, (SELECT COUNT(*) FROM ${scope.dbPrefix}sys.parameters WHERE object_id = p.object_id) AS param_count FROM ${scope.dbPrefix}sys.procedures p INNER JOIN ${scope.dbPrefix}sys.schemas s ON p.schema_id = s.schema_id ${where} ORDER BY s.name, p.name`;

			if (consola.level >= 0) logger.info(`Listing procedures in ${v.database_name || 'current DB'}`);
			const results = await pool.query(query);
			if (!results || results.length === 0) {
				return plainResponse(`No stored procedures found${v.schema_name ? ` in schema '${v.schema_name}'` : ''}.`);
			}
			const csv = formatCSV(results);
			setInCache(procsCache, cacheKey, csv, PROCS_CACHE_MAX_SIZE, 'list_stored_procedures');
			return plainResponse(csv);
		} catch (error) {
			if (consola.level >= 0) logger.error('list_stored_procedures error:', error);
			return errorResponse('Error listing procedures', error);
		}
	},

	async handleListViews(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = ListViewsInputSchema.parse(args);
			const scope = resolveDbScope(v.database_name);
			const cacheKey = namespaceCacheKey(pool.name, `${scope.dbCacheKey}${v.schema_name || '_all_'}:${v.include_system ? 'sys' : 'user'}`);

			const cached = getFromCache(viewsCache, cacheKey, VIEWS_CACHE_TTL_MS);
			if (cached !== null) return cachedResponse(cached);

			const filters: string[] = [];
			if (!v.include_system) filters.push('vw.is_ms_shipped = 0');
			if (v.schema_name) filters.push(`s.name = '${escapeLiteral(v.schema_name)}'`);
			const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

			const query = `SELECT s.name AS schema_name, vw.name AS view_name, vw.create_date, vw.modify_date FROM ${scope.dbPrefix}sys.views vw INNER JOIN ${scope.dbPrefix}sys.schemas s ON vw.schema_id = s.schema_id ${where} ORDER BY s.name, vw.name`;

			if (consola.level >= 0) logger.info(`Listing views in ${v.database_name || 'current DB'}`);
			const results = await pool.query(query);
			if (!results || results.length === 0) {
				return plainResponse(`No views found${v.schema_name ? ` in schema '${v.schema_name}'` : ''}.`);
			}
			const csv = formatCSV(results);
			setInCache(viewsCache, cacheKey, csv, VIEWS_CACHE_MAX_SIZE, 'list_views');
			return plainResponse(csv);
		} catch (error) {
			if (consola.level >= 0) logger.error('list_views error:', error);
			return errorResponse('Error listing views', error);
		}
	},

	async handleListFunctions(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = ListFunctionsInputSchema.parse(args);
			const scope = resolveDbScope(v.database_name);
			const cacheKey = namespaceCacheKey(pool.name, `${scope.dbCacheKey}${v.schema_name || '_all_'}:${v.include_system ? 'sys' : 'user'}`);

			const cached = getFromCache(functionsCache, cacheKey, FUNCTIONS_CACHE_TTL_MS);
			if (cached !== null) return cachedResponse(cached);

			const filters: string[] = [`o.type IN ('FN','IF','TF','AF','FS','FT')`];
			if (!v.include_system) filters.push('o.is_ms_shipped = 0');
			if (v.schema_name) filters.push(`s.name = '${escapeLiteral(v.schema_name)}'`);
			const where = `WHERE ${filters.join(' AND ')}`;

			const query = `SELECT s.name AS schema_name, o.name AS function_name, o.type_desc AS function_type, o.create_date, o.modify_date FROM ${scope.dbPrefix}sys.objects o INNER JOIN ${scope.dbPrefix}sys.schemas s ON o.schema_id = s.schema_id ${where} ORDER BY s.name, o.name`;

			if (consola.level >= 0) logger.info(`Listing functions in ${v.database_name || 'current DB'}`);
			const results = await pool.query(query);
			if (!results || results.length === 0) {
				return plainResponse(`No user-defined functions found${v.schema_name ? ` in schema '${v.schema_name}'` : ''}.`);
			}
			const csv = formatCSV(results);
			setInCache(functionsCache, cacheKey, csv, FUNCTIONS_CACHE_MAX_SIZE, 'list_functions');
			return plainResponse(csv);
		} catch (error) {
			if (consola.level >= 0) logger.error('list_functions error:', error);
			return errorResponse('Error listing functions', error);
		}
	},

	async handleListTriggers(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = ListTriggersInputSchema.parse(args);
			const scope = resolveDbScope(v.database_name);
			const tableFilter = v.table_name || '_all_';
			const cacheKey = namespaceCacheKey(pool.name, `${scope.dbCacheKey}${tableFilter}:${v.include_system ? 'sys' : 'user'}`);

			const cached = getFromCache(triggersCache, cacheKey, TRIGGERS_CACHE_TTL_MS);
			if (cached !== null) return cachedResponse(cached);

			const filters: string[] = [`t.parent_class = 1`];
			if (!v.include_system) filters.push('t.is_ms_shipped = 0');
			if (v.table_name) {
				filters.push(`OBJECT_NAME(t.parent_id, ${scope.dbIdExpr}) = '${escapeLiteral(v.table_name)}'`);
			}
			const where = `WHERE ${filters.join(' AND ')}`;

			const eventFlagsSubq = `STUFF((SELECT ',' + te.type_desc FROM ${scope.dbPrefix}sys.trigger_events te WHERE te.object_id = t.object_id FOR XML PATH('')), 1, 1, '')`;

			const query = `SELECT OBJECT_SCHEMA_NAME(t.parent_id, ${scope.dbIdExpr}) AS table_schema, OBJECT_NAME(t.parent_id, ${scope.dbIdExpr}) AS table_name, t.name AS trigger_name, t.is_disabled, t.is_instead_of_trigger, ${eventFlagsSubq} AS events, t.create_date, t.modify_date FROM ${scope.dbPrefix}sys.triggers t ${where} ORDER BY OBJECT_NAME(t.parent_id, ${scope.dbIdExpr}), t.name`;

			if (consola.level >= 0) logger.info(`Listing triggers in ${v.database_name || 'current DB'}`);
			const results = await pool.query(query);
			if (!results || results.length === 0) {
				return plainResponse(`No DML triggers found${v.table_name ? ` for table '${v.table_name}'` : ''}.`);
			}
			const csv = formatCSV(results);
			setInCache(triggersCache, cacheKey, csv, TRIGGERS_CACHE_MAX_SIZE, 'list_triggers');
			return plainResponse(csv);
		} catch (error) {
			if (consola.level >= 0) logger.error('list_triggers error:', error);
			return errorResponse('Error listing triggers', error);
		}
	},

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
	},

	clearCachesForTesting(): void {
		procsCache.clear();
		viewsCache.clear();
		functionsCache.clear();
		triggersCache.clear();
		definitionsCache.clear();
	},
};
