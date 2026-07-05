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
