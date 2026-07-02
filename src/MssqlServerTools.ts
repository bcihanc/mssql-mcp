import type { TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import { z } from 'zod/v4';
import type { ConnectionPool } from './server/connection.js';
import { formatCSV } from './utils/csv.js';
import { buildCacheKeyPrefix, namespaceCacheKey, validateDatabaseName } from './utils/identifier.js';
import { ConnectionScopeSchema } from './utils/connectionScope.js';

const logger = consola.withTag('mssql-server-tools');

interface ToolCacheEntry {
	result: string;
	timestamp: number;
	lastAccessed: number;
}

const DATABASES_CACHE_TTL_MS = parseInt(process.env.MSSQL_DATABASES_CACHE_TTL || '1800000', 10);
const SCHEMAS_CACHE_TTL_MS = parseInt(process.env.MSSQL_SCHEMAS_CACHE_TTL || '7200000', 10);
const SCHEMAS_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_SCHEMAS_CACHE_SIZE || '50', 10);
const LINKED_SERVERS_CACHE_TTL_MS = parseInt(process.env.MSSQL_LINKED_SERVERS_CACHE_TTL || '3600000', 10);
const SERVER_INFO_CACHE_TTL_MS = parseInt(process.env.MSSQL_SERVER_INFO_CACHE_TTL || '300000', 10);

const databasesCache = new Map<string, ToolCacheEntry>();
const schemasCache = new Map<string, ToolCacheEntry>();
const linkedServersCache = new Map<string, ToolCacheEntry>();
const serverInfoCache = new Map<string, ToolCacheEntry>();

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

const ListDatabasesInputSchema = z.object({
	include_system: z.boolean().optional().describe('Include system databases (master, tempdb, model, msdb). Default: false.'),
});

const ListSchemasInputSchema = z.object({
	database_name: z.string().optional().describe('Optional cross-database scope. Default: current database.'),
});

const ListLinkedServersInputSchema = z.object({});

const GetServerInfoInputSchema = z.object({});

const TOOL_NAMES = new Set([
	'list_databases',
	'list_schemas',
	'list_linked_servers',
	'get_server_info',
]);

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
	return msg.includes('permission') || msg.includes('denied') || msg.includes('not have permission');
}

export const MssqlServerTools = {
	canHandle(name: string): boolean {
		return TOOL_NAMES.has(name);
	},

	getToolDefinitions(): Tool[] {
		return [
			{
				name: 'list_databases',
				description: 'List all databases on the SQL Server with id, name, state, recovery model, collation, create date, and compatibility level. Filters out system databases (master, tempdb, model, msdb) by default; pass include_system=true to include them.',
				inputSchema: z.toJSONSchema(ListDatabasesInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
			{
				name: 'list_schemas',
				description: 'List all schemas in a database with schema id, name, and owner. Supports cross-database via the optional database_name parameter (default: current database).',
				inputSchema: z.toJSONSchema(ListSchemasInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
			{
				name: 'list_linked_servers',
				description: 'List all linked servers configured on this SQL Server instance (sys.servers). Returns name, product, provider, data source, and remote login/data access flags. Excludes the local server (server_id = 0).',
				inputSchema: z.toJSONSchema(ListLinkedServersInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
			{
				name: 'get_server_info',
				description: 'Get SQL Server instance metadata: edition, product version, collation, machine name, server name, language, clustered/AlwaysOn flags, and full @@VERSION string. Optionally includes CPU count and memory if VIEW SERVER STATE permission is available (gracefully omitted if not).',
				inputSchema: z.toJSONSchema(GetServerInfoInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
		];
	},

	async handleTool(name: string, args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		switch (name) {
			case 'list_databases':
				return this.handleListDatabases(args, pool);
			case 'list_schemas':
				return this.handleListSchemas(args, pool);
			case 'list_linked_servers':
				return this.handleListLinkedServers(pool);
			case 'get_server_info':
				return this.handleGetServerInfo(pool);
		}
		throw new Error(`Unknown tool: ${name}`);
	},

	async handleListDatabases(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = ListDatabasesInputSchema.parse(args);
			const cacheKey = v.include_system ? 'all' : 'user';
			const nsCacheKey = namespaceCacheKey(pool.name, cacheKey);
			const cached = getFromCache(databasesCache, nsCacheKey, DATABASES_CACHE_TTL_MS);
			if (cached !== null) return cachedResponse(cached);

			const where = v.include_system ? '' : `WHERE d.database_id > 4`;
			const query = `SELECT d.database_id, d.name AS database_name, d.state_desc, d.recovery_model_desc, d.collation_name, d.create_date, d.compatibility_level FROM sys.databases d ${where} ORDER BY d.name`;

			if (consola.level >= 0) logger.info(`Listing databases (include_system=${!!v.include_system})`);
			const results = await pool.query(query);
			if (!results || results.length === 0) {
				return plainResponse('No databases found.');
			}
			const csv = formatCSV(results);
			setInCache(databasesCache, nsCacheKey, csv, 4, 'list_databases');
			return plainResponse(csv);
		} catch (error) {
			if (consola.level >= 0) logger.error('list_databases error:', error);
			return errorResponse('Error listing databases', error);
		}
	},

	async handleListSchemas(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = ListSchemasInputSchema.parse(args);
			let dbPrefix = '';
			let cacheKey = buildCacheKeyPrefix();
			if (v.database_name) {
				const bracketed = validateDatabaseName(v.database_name);
				dbPrefix = `${bracketed}.`;
				cacheKey = buildCacheKeyPrefix(v.database_name);
			}
			const nsCacheKey = namespaceCacheKey(pool.name, cacheKey);

			const cached = getFromCache(schemasCache, nsCacheKey, SCHEMAS_CACHE_TTL_MS);
			if (cached !== null) return cachedResponse(cached);

			const query = `SELECT s.schema_id, s.name AS schema_name, COALESCE(p.name, '<unknown>') AS owner_name FROM ${dbPrefix}sys.schemas s LEFT JOIN ${dbPrefix}sys.database_principals p ON s.principal_id = p.principal_id ORDER BY s.name`;

			if (consola.level >= 0) logger.info(`Listing schemas in ${v.database_name || 'current DB'}`);
			const results = await pool.query(query);
			if (!results || results.length === 0) {
				return plainResponse(`No schemas found in ${v.database_name || 'current database'}.`);
			}
			const csv = formatCSV(results);
			setInCache(schemasCache, nsCacheKey, csv, SCHEMAS_CACHE_MAX_SIZE, 'list_schemas');
			return plainResponse(csv);
		} catch (error) {
			if (consola.level >= 0) logger.error('list_schemas error:', error);
			return errorResponse('Error listing schemas', error);
		}
	},

	async handleListLinkedServers(pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const cacheKey = namespaceCacheKey(pool.name, '_singleton_');
			const cached = getFromCache(linkedServersCache, cacheKey, LINKED_SERVERS_CACHE_TTL_MS);
			if (cached !== null) return cachedResponse(cached);

			const query = `SELECT s.server_id, s.name, s.product, s.provider, s.data_source, s.location, s.is_linked, s.is_remote_login_enabled, s.is_data_access_enabled, s.is_rpc_out_enabled, s.modify_date FROM master.sys.servers s WHERE s.server_id != 0 ORDER BY s.name`;

			if (consola.level >= 0) logger.info('Listing linked servers');
			let results;
			try {
				results = await pool.query(query);
			} catch (e) {
				if (isPermissionError(e)) {
					return plainResponse(
						`🔒 Cannot list linked servers — connection user lacks SELECT permission on master.sys.servers. ` +
						`Run: GRANT SELECT ON master.sys.servers TO [user]`,
					);
				}
				throw e;
			}

			if (!results || results.length === 0) {
				return plainResponse('No linked servers configured on this SQL Server instance.');
			}
			const csv = formatCSV(results);
			setInCache(linkedServersCache, cacheKey, csv, 1, 'list_linked_servers');
			return plainResponse(csv);
		} catch (error) {
			if (consola.level >= 0) logger.error('list_linked_servers error:', error);
			return errorResponse('Error listing linked servers', error);
		}
	},

	async handleGetServerInfo(pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const cacheKey = namespaceCacheKey(pool.name, '_singleton_');
			const cached = getFromCache(serverInfoCache, cacheKey, SERVER_INFO_CACHE_TTL_MS);
			if (cached !== null) return cachedResponse(cached);

			// Always-available properties via SERVERPROPERTY (no permissions needed)
			const propsQuery = `SELECT
				CAST(SERVERPROPERTY('ProductVersion') AS VARCHAR(128)) AS product_version,
				CAST(SERVERPROPERTY('Edition') AS VARCHAR(256)) AS edition,
				CAST(SERVERPROPERTY('ProductLevel') AS VARCHAR(64)) AS product_level,
				CAST(SERVERPROPERTY('ProductUpdateLevel') AS VARCHAR(64)) AS product_update_level,
				CAST(SERVERPROPERTY('Collation') AS VARCHAR(128)) AS collation,
				CAST(SERVERPROPERTY('MachineName') AS VARCHAR(128)) AS machine_name,
				CAST(SERVERPROPERTY('InstanceName') AS VARCHAR(128)) AS instance_name,
				CAST(SERVERPROPERTY('IsClustered') AS INT) AS is_clustered,
				CAST(SERVERPROPERTY('IsHadrEnabled') AS INT) AS is_alwayson_enabled,
				CAST(SERVERPROPERTY('IsIntegratedSecurityOnly') AS INT) AS is_integrated_security_only,
				@@SERVERNAME AS server_name,
				@@LANGUAGE AS language,
				@@SPID AS current_spid`;

			if (consola.level >= 0) logger.info('Fetching server info (SERVERPROPERTY layer)');
			const propsResults = await pool.query<Record<string, unknown>>(propsQuery);
			const props = propsResults[0] || {};

			// Optional layer: dm_os_sys_info requires VIEW SERVER STATE
			let osInfo: Record<string, unknown> | null = null;
			let osInfoError: string | null = null;
			try {
				const osQuery = `SELECT cpu_count, hyperthread_ratio, physical_memory_kb / 1024 / 1024 AS physical_memory_gb, virtual_memory_kb / 1024 / 1024 AS virtual_memory_gb, sqlserver_start_time FROM sys.dm_os_sys_info`;
				const osResults = await pool.query<Record<string, unknown>>(osQuery);
				osInfo = osResults[0] || null;
			} catch (e) {
				if (isPermissionError(e)) {
					osInfoError = 'VIEW SERVER STATE permission required for cpu/memory/uptime — omitting.';
				} else {
					osInfoError = `dm_os_sys_info error: ${e instanceof Error ? e.message : 'unknown'}`;
				}
			}

			const merged: Record<string, unknown> = { ...props };
			if (osInfo) Object.assign(merged, osInfo);

			const csv = formatCSV([merged]);
			const finalText = osInfoError ? `${csv}\n\nℹ️ ${osInfoError}` : csv;
			setInCache(serverInfoCache, cacheKey, finalText, 1, 'get_server_info');
			return plainResponse(finalText);
		} catch (error) {
			if (consola.level >= 0) logger.error('get_server_info error:', error);
			return errorResponse('Error fetching server info', error);
		}
	},

	clearCachesForTesting(): void {
		databasesCache.clear();
		schemasCache.clear();
		linkedServersCache.clear();
		serverInfoCache.clear();
	},
};
