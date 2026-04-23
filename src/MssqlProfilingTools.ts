import type { TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import { z } from 'zod/v4';
import type { ConnectionPool } from './server/connection.js';
import { formatCSV } from './utils/csv.js';
import { buildCacheKeyPrefix, parseObjectName, validateDatabaseName } from './utils/identifier.js';

const logger = consola.withTag('mssql-profiling-tools');

interface ToolCacheEntry {
	result: string;
	timestamp: number;
	lastAccessed: number;
}

const PROFILE_CACHE_TTL_MS = parseInt(process.env.MSSQL_PROFILE_CACHE_TTL || '1800000', 10);
const PROFILE_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_PROFILE_CACHE_SIZE || '100', 10);
const ROW_COUNT_CACHE_TTL_MS = parseInt(process.env.MSSQL_ROW_COUNT_CACHE_TTL || '900000', 10);
const ROW_COUNT_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_ROW_COUNT_CACHE_SIZE || '200', 10);

const profileCache = new Map<string, ToolCacheEntry>();
const rowCountCache = new Map<string, ToolCacheEntry>();

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

const ProfileColumnInputSchema = z.object({
	table_name: z.string().min(1).describe('Table name. 1-part ("MyTable") or 2-part ("dbo.MyTable").'),
	column_name: z.string().min(1).describe('Column to profile. Single-part name only.'),
	database_name: z.string().optional().describe('Optional cross-database scope. Default: current database.'),
	sample_size: z.number().int().positive().optional().describe('If set, profile only a random sample of N rows (faster on large tables, but distinct_count and top values are estimates).'),
});

const TableSampleInputSchema = z.object({
	table_name: z.string().min(1).describe('Table name. 1-part or 2-part.'),
	database_name: z.string().optional().describe('Optional cross-database scope.'),
	sample_rows: z.number().int().positive().optional().describe('Number of random rows to return (default: 10, max: 100).'),
});

const RowCountInputSchema = z.object({
	table_name: z.string().min(1).describe('Table name. 1-part or 2-part.'),
	database_name: z.string().optional().describe('Optional cross-database scope.'),
	exact: z.boolean().optional().describe('If true, runs SELECT COUNT_BIG(*) for exact count (slower on large tables). Default: false (uses fast metadata estimate, falls back to exact if estimate fails).'),
});

const TOOL_NAMES = new Set(['profile_column', 'get_table_sample', 'get_table_row_count']);
const SAMPLE_HARD_CAP = 100;

interface ResolvedTable {
	dbPrefix: string;
	dbCacheKey: string;
	schemaName: string;
	tableName: string;
	displayName: string;
	bracketedFqn: string;
}

function resolveTable(name: string, databaseName?: string): ResolvedTable {
	const parts = parseObjectName(name);
	if (parts.database) {
		throw new Error(
			`3-part name "${name}" is not allowed in this parameter. Pass the database via the "database_name" parameter and use 1- or 2-part name.`,
		);
	}
	const schemaName = parts.schema || 'dbo';
	let dbPrefix = '';
	let dbCacheKey = buildCacheKeyPrefix();
	if (databaseName) {
		const bracketed = validateDatabaseName(databaseName);
		dbPrefix = `${bracketed}.`;
		dbCacheKey = buildCacheKeyPrefix(databaseName);
	}
	const bracketedFqn = `${dbPrefix}[${schemaName}].[${parts.object}]`;
	const displayName = databaseName
		? `${databaseName}.${schemaName}.${parts.object}`
		: `${schemaName}.${parts.object}`;
	return {
		dbPrefix,
		dbCacheKey,
		schemaName,
		tableName: parts.object,
		displayName,
		bracketedFqn,
	};
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

export const MssqlProfilingTools = {
	canHandle(name: string): boolean {
		return TOOL_NAMES.has(name);
	},

	getToolDefinitions(): Tool[] {
		return [
			{
				name: 'profile_column',
				description: 'Profile a column with row count, null count, null %, distinct count, min/max, and top 10 most frequent values. WARNING: COUNT(DISTINCT) and aggregate operations may be slow on large tables — use the optional sample_size parameter to profile a random subset (estimates only). Some column types (text/ntext/image, xml, spatial) may produce errors on aggregation; these surface as friendly errors.',
				inputSchema: z.toJSONSchema(ProfileColumnInputSchema) as any,
			},
			{
				name: 'get_table_sample',
				description: 'Return a random sample of N rows from a table (default: 10, hard cap: 100). Uses ORDER BY NEWID() rather than TABLESAMPLE for reliable results on small tables. Not cached (each call returns a fresh random sample).',
				inputSchema: z.toJSONSchema(TableSampleInputSchema) as any,
			},
			{
				name: 'get_table_row_count',
				description: 'Get the row count of a table. Default uses fast metadata estimate (sys.partitions / sys.sysindexes — usually <10ms). Set exact=true for SELECT COUNT_BIG(*) which is slower but always accurate. Three-tier fallback: sys.partitions → sys.sysindexes → COUNT_BIG (when partitions return 0 or are not accessible).',
				inputSchema: z.toJSONSchema(RowCountInputSchema) as any,
			},
		];
	},

	async handleTool(name: string, args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		switch (name) {
			case 'profile_column':
				return this.handleProfileColumn(args, pool);
			case 'get_table_sample':
				return this.handleTableSample(args, pool);
			case 'get_table_row_count':
				return this.handleRowCount(args, pool);
		}
		throw new Error(`Unknown tool: ${name}`);
	},

	async handleProfileColumn(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = ProfileColumnInputSchema.parse(args);
			const table = resolveTable(v.table_name, v.database_name);

			// Validate column_name (single part, alphanumeric + underscore only)
			if (!/^[a-zA-Z0-9_]+$/.test(v.column_name)) {
				throw new Error(`Invalid column_name "${v.column_name}". Only alphanumeric characters and underscores allowed.`);
			}
			const colBracketed = `[${v.column_name}]`;
			const sampleKey = v.sample_size ? `s${v.sample_size}` : 'full';
			const cacheKey = `${table.dbCacheKey}${table.schemaName}:${table.tableName}:${v.column_name}:${sampleKey}`;

			const cached = getFromCache(profileCache, cacheKey, PROFILE_CACHE_TTL_MS);
			if (cached !== null) return cachedResponse(cached);

			const sourceExpr = v.sample_size
				? `(SELECT TOP ${v.sample_size} ${colBracketed} FROM ${table.bracketedFqn} ORDER BY NEWID()) AS sampled`
				: `${table.bracketedFqn}`;

			const aggregateQuery = `SELECT COUNT_BIG(*) AS row_count, COUNT_BIG(*) - COUNT_BIG(${colBracketed}) AS null_count, CAST((COUNT_BIG(*) - COUNT_BIG(${colBracketed})) * 100.0 / NULLIF(COUNT_BIG(*), 0) AS DECIMAL(5,2)) AS null_pct, COUNT(DISTINCT ${colBracketed}) AS distinct_count, MIN(${colBracketed}) AS min_value, MAX(${colBracketed}) AS max_value FROM ${sourceExpr}`;

			const topQuery = `SELECT TOP 10 ${colBracketed} AS value, COUNT_BIG(*) AS occurrences FROM ${sourceExpr} WHERE ${colBracketed} IS NOT NULL GROUP BY ${colBracketed} ORDER BY occurrences DESC`;

			if (consola.level >= 0) logger.info(`Profiling ${table.displayName}.${v.column_name}${v.sample_size ? ` (sample ${v.sample_size})` : ''}`);

			let aggResults: any[];
			try {
				aggResults = await pool.query(aggregateQuery);
			} catch (e) {
				const msg = e instanceof Error ? e.message : 'unknown';
				return plainResponse(`📊 ${table.displayName}.${v.column_name} — could not aggregate: ${msg}\n\n` +
					`This usually means the column type does not support MIN/MAX/DISTINCT (e.g. text, ntext, image, xml, geography).`);
			}

			let topResults: any[] = [];
			try {
				topResults = await pool.query(topQuery);
			} catch {
				// Top values are best-effort; main aggregates are still useful
			}

			const sampledNote = v.sample_size ? `\n\nℹ️ Stats are based on a random sample of ${v.sample_size} rows; distinct_count and top values are estimates.` : '';
			let body = `Aggregates for ${table.displayName}.${v.column_name}:\n${formatCSV(aggResults)}`;
			if (topResults.length > 0) {
				body += `\n\nTop 10 most frequent values:\n${formatCSV(topResults)}`;
			} else {
				body += `\n\n(No top values — column may be all NULL or top-values query failed.)`;
			}
			body += sampledNote;

			setInCache(profileCache, cacheKey, body, PROFILE_CACHE_MAX_SIZE, 'profile_column');
			return plainResponse(body);
		} catch (error) {
			if (consola.level >= 0) logger.error('profile_column error:', error);
			return errorResponse('Error profiling column', error);
		}
	},

	async handleTableSample(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = TableSampleInputSchema.parse(args);
			const table = resolveTable(v.table_name, v.database_name);
			let n = v.sample_rows ?? 10;
			if (n > SAMPLE_HARD_CAP) n = SAMPLE_HARD_CAP;
			if (n < 1) n = 1;

			const query = `SELECT TOP ${n} * FROM ${table.bracketedFqn} ORDER BY NEWID()`;

			if (consola.level >= 0) logger.info(`Sampling ${n} rows from ${table.displayName}`);
			const results = await pool.query(query);
			if (!results || results.length === 0) {
				return plainResponse(`📭 ${table.displayName} — table is empty.`);
			}
			const csv = formatCSV(results);
			const note = n === SAMPLE_HARD_CAP ? `\n\nℹ️ sample_rows capped at ${SAMPLE_HARD_CAP} (hard limit).` : '';
			return plainResponse(`Random sample (${results.length} rows) from ${table.displayName}:\n${csv}${note}`);
		} catch (error) {
			if (consola.level >= 0) logger.error('get_table_sample error:', error);
			return errorResponse('Error sampling table', error);
		}
	},

	async handleRowCount(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = RowCountInputSchema.parse(args);
			const table = resolveTable(v.table_name, v.database_name);
			const cacheKey = `${table.dbCacheKey}${table.schemaName}:${table.tableName}:${v.exact ? 'exact' : 'fast'}`;

			const cached = getFromCache(rowCountCache, cacheKey, ROW_COUNT_CACHE_TTL_MS);
			if (cached !== null) return cachedResponse(cached);

			const fqnLiteral = `'${escapeLiteral(`${table.schemaName}.${table.tableName}`)}'`;
			const objectIdExpr = v.database_name
				? `OBJECT_ID('${escapeLiteral(`${v.database_name}.${table.schemaName}.${table.tableName}`)}')`
				: `OBJECT_ID(${fqnLiteral})`;

			let rowCount: number | bigint | null = null;
			let source = 'unknown';

			if (!v.exact) {
				// Tier 1: sys.dm_db_partition_stats (modern, requires VIEW DATABASE STATE)
				try {
					const r = await pool.query<{ row_count: number | bigint }>(
						`SELECT SUM(p.row_count) AS row_count FROM ${table.dbPrefix}sys.dm_db_partition_stats p WHERE p.object_id = ${objectIdExpr} AND p.index_id IN (0, 1)`,
					);
					if (r[0]?.row_count != null) {
						const n = Number(r[0].row_count);
						if (n > 0) {
							rowCount = n;
							source = 'sys.dm_db_partition_stats (fast)';
						}
					}
				} catch {
					// permission denied or other error — fall through
				}

				// Tier 2: sys.sysindexes (deprecated but always accessible)
				if (rowCount == null) {
					try {
						const r = await pool.query<{ rowcnt: number | bigint }>(
							`SELECT SUM(rowcnt) AS rowcnt FROM ${table.dbPrefix}sys.sysindexes WHERE id = ${objectIdExpr} AND indid IN (0, 1)`,
						);
						if (r[0]?.rowcnt != null) {
							const n = Number(r[0].rowcnt);
							if (n > 0) {
								rowCount = n;
								source = 'sys.sysindexes (estimate, may be stale until next stats update)';
							}
						}
					} catch {
						// fall through to exact
					}
				}
			}

			// Tier 3: exact COUNT_BIG (always accurate but can be slow)
			if (rowCount == null) {
				try {
					const r = await pool.query<{ cnt: number | bigint }>(`SELECT COUNT_BIG(*) AS cnt FROM ${table.bracketedFqn}`);
					rowCount = Number(r[0]?.cnt ?? 0);
					source = v.exact ? 'COUNT_BIG(*) (exact)' : 'COUNT_BIG(*) (fallback after metadata returned 0)';
				} catch (e) {
					if (isPermissionError(e)) {
						return plainResponse(
							`🔒 ${table.displayName} — cannot count rows. Connection user lacks SELECT permission on this table.`,
						);
					}
					throw e;
				}
			}

			const text = `Row count for ${table.displayName}: ${rowCount}\nSource: ${source}`;
			setInCache(rowCountCache, cacheKey, text, ROW_COUNT_CACHE_MAX_SIZE, 'get_table_row_count');
			return plainResponse(text);
		} catch (error) {
			if (consola.level >= 0) logger.error('get_table_row_count error:', error);
			return errorResponse('Error getting row count', error);
		}
	},

	clearCachesForTesting(): void {
		profileCache.clear();
		rowCountCache.clear();
	},
};
