import type { TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import { z } from 'zod/v4';
import type { ConnectionPool } from './server/connection.js';
import { formatCSV } from './utils/csv.js';
import {
	buildCacheKeyPrefix,
	parseObjectName,
	validateDatabaseName,
} from './utils/identifier.js';
import {
	DEFINITION_DEFAULT_LINES,
	DEFINITION_MAX_LINES,
	formatPaginatedResponse,
	paginateLines,
} from './utils/pagination.js';

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
const DEFINITION_CACHE_TTL_MS = parseInt(process.env.MSSQL_DEFINITION_CACHE_TTL || '14400000', 10);
const DEFINITION_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_DEFINITION_CACHE_SIZE || '200', 10);
const DEPENDENCIES_CACHE_TTL_MS = parseInt(process.env.MSSQL_DEPENDENCIES_CACHE_TTL || '14400000', 10);
const DEPENDENCIES_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_DEPENDENCIES_CACHE_SIZE || '100', 10);

const procsCache = new Map<string, ToolCacheEntry>();
const viewsCache = new Map<string, ToolCacheEntry>();
const functionsCache = new Map<string, ToolCacheEntry>();
const triggersCache = new Map<string, ToolCacheEntry>();
const definitionCache = new Map<string, ToolCacheEntry>();
const dependenciesCache = new Map<string, ToolCacheEntry>();

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

const DefinitionInputSchema = DatabaseScopeSchema.extend({
	name: z.string().min(1).describe('Object name. Either 1-part ("MyProc", uses dbo schema) or 2-part ("schema.MyProc"). Use database_name parameter for cross-database access — do NOT use 3-part names here.'),
	offset_lines: z.number().int().optional().describe(`Pagination offset in lines (default: 0)`),
	max_lines: z.number().int().optional().describe(`Pagination max lines per page (default: ${DEFINITION_DEFAULT_LINES}, hard cap: ${DEFINITION_MAX_LINES})`),
});

const DependencyInputSchema = DatabaseScopeSchema.extend({
	name: z.string().min(1).describe('Target object name. 1-part ("MyTable") or 2-part ("dbo.MyTable").'),
});

const TOOL_NAMES = new Set([
	'list_stored_procedures',
	'get_procedure_definition',
	'list_views',
	'get_view_definition',
	'list_functions',
	'get_function_definition',
	'list_triggers',
	'get_trigger_definition',
	'get_object_dependencies',
	'get_referenced_objects',
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

interface ResolvedObject extends ResolvedScope {
	schemaName: string;
	objectName: string;
	displayName: string;
}

function resolveObject(name: string, databaseName?: string): ResolvedObject {
	const parts = parseObjectName(name);
	if (parts.database) {
		throw new Error(
			`3-part name "${name}" is not allowed in this parameter. Pass the database via the "database_name" parameter and use 1- or 2-part name (e.g. "${parts.schema || 'dbo'}.${parts.object}").`,
		);
	}
	const scope = resolveDbScope(databaseName);
	const schemaName = parts.schema || 'dbo';
	return {
		...scope,
		schemaName,
		objectName: parts.object,
		displayName: databaseName
			? `${databaseName}.${schemaName}.${parts.object}`
			: `${schemaName}.${parts.object}`,
	};
}

function escapeLiteral(s: string): string {
	return s.replace(/'/g, "''");
}

function emptyResponse(message: string): { content: TextContent[] } {
	return { content: [{ type: 'text', text: message }] };
}

function cachedResponse(text: string): { content: TextContent[] } {
	return { content: [{ type: 'text', text: `${text}\n\n📋 (Cached result)` }] };
}

function plainResponse(text: string): { content: TextContent[] } {
	return { content: [{ type: 'text', text }] };
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
				inputSchema: z.toJSONSchema(ListProcsInputSchema) as any,
			},
			{
				name: 'get_procedure_definition',
				description: 'Get the T-SQL definition (body) of a stored procedure with line-based pagination. Returns paginated content with header showing total_lines, has_more, and next_offset. Encrypted procedures (WITH ENCRYPTION) and procedures the user lacks VIEW DEFINITION permission on will return a friendly explanation instead.',
				inputSchema: z.toJSONSchema(DefinitionInputSchema) as any,
			},
			{
				name: 'list_views',
				description: 'List all views with schema, name, and create/modify dates. Supports cross-database queries via the optional database_name parameter. Filters out system-shipped views by default.',
				inputSchema: z.toJSONSchema(ListViewsInputSchema) as any,
			},
			{
				name: 'get_view_definition',
				description: 'Get the T-SQL definition (CREATE VIEW statement) of a view with line-based pagination. Same pagination behavior as get_procedure_definition.',
				inputSchema: z.toJSONSchema(DefinitionInputSchema) as any,
			},
			{
				name: 'list_functions',
				description: 'List all user-defined functions (scalar, inline TVF, multi-statement TVF, CLR aggregate) with schema, name, type, and create/modify dates. Supports cross-database queries.',
				inputSchema: z.toJSONSchema(ListFunctionsInputSchema) as any,
			},
			{
				name: 'get_function_definition',
				description: 'Get the T-SQL definition of a function (scalar/TVF) with line-based pagination.',
				inputSchema: z.toJSONSchema(DefinitionInputSchema) as any,
			},
			{
				name: 'list_triggers',
				description: 'List DML triggers with parent table, name, type (INSTEAD OF / AFTER), enabled state, and the events they fire on (INSERT/UPDATE/DELETE). Optionally filter by parent table_name.',
				inputSchema: z.toJSONSchema(ListTriggersInputSchema) as any,
			},
			{
				name: 'get_trigger_definition',
				description: 'Get the T-SQL definition of a trigger with line-based pagination.',
				inputSchema: z.toJSONSchema(DefinitionInputSchema) as any,
			},
			{
				name: 'get_object_dependencies',
				description: 'Get all objects that reference the given object (e.g. "which procedures use this table?"). Uses sys.sql_expression_dependencies — requires VIEW DEFINITION permission. Returns referencing object schema, name, and type.',
				inputSchema: z.toJSONSchema(DependencyInputSchema) as any,
			},
			{
				name: 'get_referenced_objects',
				description: 'Get all objects that the given object references (e.g. "which tables/columns does this procedure read?"). Uses sys.sql_expression_dependencies. Returns referenced database, schema, entity, and class.',
				inputSchema: z.toJSONSchema(DependencyInputSchema) as any,
			},
		];
	},

	async handleTool(name: string, args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		switch (name) {
			case 'list_stored_procedures':
				return this.handleListProcedures(args, pool);
			case 'get_procedure_definition':
				return this.handleGetDefinition(args, pool, 'P', 'procedure');
			case 'list_views':
				return this.handleListViews(args, pool);
			case 'get_view_definition':
				return this.handleGetDefinition(args, pool, 'V', 'view');
			case 'list_functions':
				return this.handleListFunctions(args, pool);
			case 'get_function_definition':
				return this.handleGetDefinition(args, pool, 'FN_TVF_IF', 'function');
			case 'list_triggers':
				return this.handleListTriggers(args, pool);
			case 'get_trigger_definition':
				return this.handleGetDefinition(args, pool, 'TR', 'trigger');
			case 'get_object_dependencies':
				return this.handleGetObjectDependencies(args, pool);
			case 'get_referenced_objects':
				return this.handleGetReferencedObjects(args, pool);
		}
		throw new Error(`Unknown tool: ${name}`);
	},

	async handleListProcedures(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = ListProcsInputSchema.parse(args);
			const scope = resolveDbScope(v.database_name);
			const cacheKey = `${scope.dbCacheKey}${v.schema_name || '_all_'}:${v.include_system ? 'sys' : 'user'}`;

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
			const cacheKey = `${scope.dbCacheKey}${v.schema_name || '_all_'}:${v.include_system ? 'sys' : 'user'}`;

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
			const cacheKey = `${scope.dbCacheKey}${v.schema_name || '_all_'}:${v.include_system ? 'sys' : 'user'}`;

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
			const cacheKey = `${scope.dbCacheKey}${tableFilter}:${v.include_system ? 'sys' : 'user'}`;

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

	async handleGetDefinition(
		args: any,
		pool: ConnectionPool,
		objectKind: 'P' | 'V' | 'FN_TVF_IF' | 'TR',
		humanLabel: string,
	): Promise<{ content: TextContent[] }> {
		try {
			const v = DefinitionInputSchema.parse(args);
			const scope = resolveObject(v.name, v.database_name);
			const cacheKey = `${scope.dbCacheKey}${humanLabel}:${scope.schemaName}:${scope.objectName}`;

			const cached = getFromCache(definitionCache, cacheKey, DEFINITION_CACHE_TTL_MS);
			let fullDefinition: string;

			if (cached !== null) {
				fullDefinition = cached;
			} else {
				let typeFilter: string;
				let lookupSql: string;
				if (objectKind === 'P') {
					typeFilter = `o.type = 'P'`;
					lookupSql = `INNER JOIN ${scope.dbPrefix}sys.schemas s ON o.schema_id = s.schema_id WHERE s.name = '${escapeLiteral(scope.schemaName)}' AND o.name = '${escapeLiteral(scope.objectName)}' AND ${typeFilter}`;
				} else if (objectKind === 'V') {
					typeFilter = `o.type = 'V'`;
					lookupSql = `INNER JOIN ${scope.dbPrefix}sys.schemas s ON o.schema_id = s.schema_id WHERE s.name = '${escapeLiteral(scope.schemaName)}' AND o.name = '${escapeLiteral(scope.objectName)}' AND ${typeFilter}`;
				} else if (objectKind === 'FN_TVF_IF') {
					typeFilter = `o.type IN ('FN','IF','TF','AF','FS','FT')`;
					lookupSql = `INNER JOIN ${scope.dbPrefix}sys.schemas s ON o.schema_id = s.schema_id WHERE s.name = '${escapeLiteral(scope.schemaName)}' AND o.name = '${escapeLiteral(scope.objectName)}' AND ${typeFilter}`;
				} else {
					typeFilter = `o.type = 'TR'`;
					lookupSql = `WHERE OBJECT_SCHEMA_NAME(o.parent_object_id, ${scope.dbIdExpr}) = '${escapeLiteral(scope.schemaName)}' AND o.name = '${escapeLiteral(scope.objectName)}' AND ${typeFilter}`;
				}

				const query = `SELECT m.definition AS def FROM ${scope.dbPrefix}sys.sql_modules m INNER JOIN ${scope.dbPrefix}sys.objects o ON m.object_id = o.object_id ${lookupSql}`;

				if (consola.level >= 0) logger.info(`Fetching ${humanLabel} definition: ${scope.displayName}`);
				const results = await pool.query<{ def: string | null }>(query);

				if (!results || results.length === 0) {
					return plainResponse(`📄 ${scope.displayName} — ${humanLabel} not found in ${v.database_name || 'current database'}.`);
				}
				const def = results[0].def;
				if (def === null || def === undefined) {
					return plainResponse(
						`📄 ${scope.displayName} — definition is unavailable. Possible causes:\n` +
						`  • Object was created WITH ENCRYPTION (definition is hidden)\n` +
						`  • Connection user lacks VIEW DEFINITION permission on this object\n` +
						`  • Run: GRANT VIEW DEFINITION ON ${scope.displayName} TO [user] (or VIEW ANY DEFINITION at server level)`,
					);
				}
				fullDefinition = def;
				setInCache(definitionCache, cacheKey, fullDefinition, DEFINITION_CACHE_MAX_SIZE, `get_${humanLabel}_definition`);
			}

			const paginated = paginateLines(fullDefinition, {
				offset_lines: v.offset_lines,
				max_lines: v.max_lines,
			});
			const text = formatPaginatedResponse(paginated, scope.displayName);
			return plainResponse(cached !== null ? `${text}\n\n📋 (Cached definition)` : text);
		} catch (error) {
			if (consola.level >= 0) logger.error(`get_${humanLabel}_definition error:`, error);
			return errorResponse(`Error fetching ${humanLabel} definition`, error);
		}
	},

	async handleGetObjectDependencies(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = DependencyInputSchema.parse(args);
			const scope = resolveObject(v.name, v.database_name);
			const cacheKey = `${scope.dbCacheKey}refby:${scope.schemaName}:${scope.objectName}`;

			const cached = getFromCache(dependenciesCache, cacheKey, DEPENDENCIES_CACHE_TTL_MS);
			if (cached !== null) return cachedResponse(cached);

			const targetExpr = `OBJECT_ID('${escapeLiteral(`${scope.dbPrefix.replace(/^\[|\]\.$/g, '') || ''}${scope.dbPrefix ? '.' : ''}${scope.schemaName}.${scope.objectName}`)}')`;
			// Simpler: use 2-part inside target DB context — sys.sql_expression_dependencies is per-DB
			const targetTwoPart = `'${escapeLiteral(scope.schemaName)}.${escapeLiteral(scope.objectName)}'`;

			const query = `SELECT DISTINCT OBJECT_SCHEMA_NAME(d.referencing_id, ${scope.dbIdExpr}) AS referencing_schema, OBJECT_NAME(d.referencing_id, ${scope.dbIdExpr}) AS referencing_object, o.type_desc AS referencing_type FROM ${scope.dbPrefix}sys.sql_expression_dependencies d INNER JOIN ${scope.dbPrefix}sys.objects o ON d.referencing_id = o.object_id WHERE d.referenced_id = OBJECT_ID(${scope.dbPrefix ? `'${escapeLiteral(v.database_name!)}.${escapeLiteral(scope.schemaName)}.${escapeLiteral(scope.objectName)}'` : targetTwoPart}) ORDER BY referencing_schema, referencing_object`;

			if (consola.level >= 0) logger.info(`Fetching dependencies for ${scope.displayName}`);
			let results;
			try {
				results = await pool.query(query);
			} catch (e) {
				const msg = e instanceof Error ? e.message.toLowerCase() : '';
				if (msg.includes('permission') || msg.includes('denied')) {
					return plainResponse(
						`🔒 ${scope.displayName} — cannot read dependencies. ` +
						`This requires VIEW DEFINITION permission on the referencing objects (or VIEW ANY DEFINITION at server level).`,
					);
				}
				throw e;
			}

			if (!results || results.length === 0) {
				return plainResponse(`📭 ${scope.displayName} — no objects reference this. (Note: indirect references via dynamic SQL are not tracked.)`);
			}
			const csv = formatCSV(results);
			setInCache(dependenciesCache, cacheKey, csv, DEPENDENCIES_CACHE_MAX_SIZE, 'get_object_dependencies');
			return plainResponse(csv);
		} catch (error) {
			if (consola.level >= 0) logger.error('get_object_dependencies error:', error);
			return errorResponse('Error fetching dependencies', error);
		}
	},

	async handleGetReferencedObjects(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = DependencyInputSchema.parse(args);
			const scope = resolveObject(v.name, v.database_name);
			const cacheKey = `${scope.dbCacheKey}refto:${scope.schemaName}:${scope.objectName}`;

			const cached = getFromCache(dependenciesCache, cacheKey, DEPENDENCIES_CACHE_TTL_MS);
			if (cached !== null) return cachedResponse(cached);

			const fullName = v.database_name
				? `${escapeLiteral(v.database_name)}.${escapeLiteral(scope.schemaName)}.${escapeLiteral(scope.objectName)}`
				: `${escapeLiteral(scope.schemaName)}.${escapeLiteral(scope.objectName)}`;

			const query = `SELECT DISTINCT d.referenced_database_name, d.referenced_schema_name, d.referenced_entity_name, d.referenced_class_desc FROM ${scope.dbPrefix}sys.sql_expression_dependencies d WHERE d.referencing_id = OBJECT_ID('${fullName}') ORDER BY d.referenced_database_name, d.referenced_schema_name, d.referenced_entity_name`;

			if (consola.level >= 0) logger.info(`Fetching referenced objects for ${scope.displayName}`);
			let results;
			try {
				results = await pool.query(query);
			} catch (e) {
				const msg = e instanceof Error ? e.message.toLowerCase() : '';
				if (msg.includes('permission') || msg.includes('denied')) {
					return plainResponse(
						`🔒 ${scope.displayName} — cannot read referenced objects. ` +
						`This requires VIEW DEFINITION permission.`,
					);
				}
				throw e;
			}

			if (!results || results.length === 0) {
				return plainResponse(`📭 ${scope.displayName} — references no other objects (or object body is empty).`);
			}
			const csv = formatCSV(results);
			setInCache(dependenciesCache, cacheKey, csv, DEPENDENCIES_CACHE_MAX_SIZE, 'get_referenced_objects');
			return plainResponse(csv);
		} catch (error) {
			if (consola.level >= 0) logger.error('get_referenced_objects error:', error);
			return errorResponse('Error fetching referenced objects', error);
		}
	},

	clearCachesForTesting(): void {
		procsCache.clear();
		viewsCache.clear();
		functionsCache.clear();
		triggersCache.clear();
		definitionCache.clear();
		dependenciesCache.clear();
	},
};
