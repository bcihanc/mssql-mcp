import type { TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import crypto from 'node:crypto';
import { z } from 'zod/v4';
import { isReadOnlyQuery } from './server/config.js';
import type { ConnectionPool } from './server/connection.js';
import { formatCSV } from './utils/csv.js';
import { namespaceCacheKey } from './utils/identifier.js';
import { ConnectionScopeSchema } from './utils/connectionScope.js';

const logger = consola.withTag('mssql-tools');

// PERFORMANCE: Configurable result size limits from environment
const MAX_RESULT_ROWS = parseInt(process.env.MSSQL_MAX_ROWS || '10000', 10);
const WARN_RESULT_ROWS = parseInt(process.env.MSSQL_WARN_ROWS || '5000', 10);

// PERFORMANCE: Query result caching with TTL and true LRU
interface QueryCacheEntry {
	result: string;
	timestamp: number;
	lastAccessed: number; // For true LRU tracking
}

const QUERY_CACHE_TTL_MS = parseInt(process.env.MSSQL_CACHE_TTL || '60000', 10); // Default 60 seconds
const QUERY_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_CACHE_SIZE || '100', 10); // Max 100 queries
const queryCache = new Map<string, QueryCacheEntry>();

// PERFORMANCE: Tool-specific caching configurations
interface ToolCacheEntry {
	result: string;
	timestamp: number;
	lastAccessed: number; // For true LRU tracking
}

// Cache TTL configurations (milliseconds)
// Database schema rarely changes, so we use longer TTLs for better performance
const TABLES_CACHE_TTL_MS = parseInt(process.env.MSSQL_TABLES_CACHE_TTL || '1800000', 10); // 30 minutes
const SCHEMA_CACHE_TTL_MS = parseInt(process.env.MSSQL_SCHEMA_CACHE_TTL || '7200000', 10); // 2 hours
const FK_CACHE_TTL_MS = parseInt(process.env.MSSQL_FK_CACHE_TTL || '14400000', 10); // 4 hours
const RELATIONSHIPS_CACHE_TTL_MS = parseInt(process.env.MSSQL_RELATIONSHIPS_CACHE_TTL || '14400000', 10); // 4 hours
const COLUMNS_CACHE_TTL_MS = parseInt(process.env.MSSQL_COLUMNS_CACHE_TTL || '7200000', 10); // 2 hours
const INDEXES_CACHE_TTL_MS = parseInt(process.env.MSSQL_INDEXES_CACHE_TTL || '14400000', 10); // 4 hours

// Cache size limits
const SCHEMA_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_SCHEMA_CACHE_SIZE || '200', 10);
const FK_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_FK_CACHE_SIZE || '100', 10);
const RELATIONSHIPS_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_RELATIONSHIPS_CACHE_SIZE || '100', 10);
const COLUMNS_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_COLUMNS_CACHE_SIZE || '100', 10);
const INDEXES_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_INDEXES_CACHE_SIZE || '200', 10);

// Cache instances for each tool
const listTablesCache = new Map<string, ToolCacheEntry>();
const tableSchemaCache = new Map<string, ToolCacheEntry>();
const foreignKeysCache = new Map<string, ToolCacheEntry>();
const relationshipsCache = new Map<string, ToolCacheEntry>();
const columnsCache = new Map<string, ToolCacheEntry>();
const indexesCache = new Map<string, ToolCacheEntry>();

// Static per-connection cache for SQL Server version (never changes during runtime)
const versionCache = new Map<string, string>();

// SECURITY: Generate cache key using SHA256 hash to prevent cache poisoning
// This ensures different queries always produce different cache keys
// and prevents attackers from crafting queries that collide with legitimate ones
function getCacheKey(query: string): string {
	// Normalize query before hashing to maintain cache efficiency
	const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, ' ');
	// Use SHA256 hash for secure, collision-resistant cache key
	return crypto.createHash('sha256').update(normalizedQuery, 'utf8').digest('hex');
}

// PERFORMANCE: Lazy cleanup - only remove expired entry when accessed
// This is O(1) instead of O(cache_size)
function cleanExpiredEntry(key: string): boolean {
	const entry = queryCache.get(key);
	if (entry && Date.now() - entry.timestamp > QUERY_CACHE_TTL_MS) {
		queryCache.delete(key);
		return true; // Entry was expired and removed
	}
	return false; // Entry is still valid or doesn't exist
}

// PERFORMANCE: True LRU eviction - removes least recently accessed entries
function enforceCacheSizeLimit(): void {
	if (queryCache.size > QUERY_CACHE_MAX_SIZE) {
		// Sort entries by lastAccessed time and remove oldest ones
		const entries = Array.from(queryCache.entries()).sort(
			(a, b) => a[1].lastAccessed - b[1].lastAccessed,
		);

		const entriesToDelete = queryCache.size - QUERY_CACHE_MAX_SIZE;
		for (let i = 0; i < entriesToDelete; i++) {
			queryCache.delete(entries[i][0]);
		}

		if (consola.level >= 0) {
			logger.debug(`LRU eviction: removed ${entriesToDelete} least recently used entries`);
		}
	}
}

// PERFORMANCE: Generic cache helpers for tool-specific caches
function cleanExpiredToolEntry(cache: Map<string, ToolCacheEntry>, key: string, ttlMs: number): boolean {
	const entry = cache.get(key);
	if (entry && Date.now() - entry.timestamp > ttlMs) {
		cache.delete(key);
		return true; // Entry was expired and removed
	}
	return false; // Entry is still valid or doesn't exist
}

function enforceToolCacheSizeLimit(cache: Map<string, ToolCacheEntry>, maxSize: number, cacheName: string): void {
	if (cache.size > maxSize) {
		// Sort entries by lastAccessed time and remove oldest ones
		const entries = Array.from(cache.entries()).sort(
			(a, b) => a[1].lastAccessed - b[1].lastAccessed,
		);

		const entriesToDelete = cache.size - maxSize;
		for (let i = 0; i < entriesToDelete; i++) {
			cache.delete(entries[i][0]);
		}

		if (consola.level >= 0) {
			logger.debug(`${cacheName} LRU eviction: removed ${entriesToDelete} least recently used entries`);
		}
	}
}

// PERFORMANCE: Get from cache with automatic expiry check and LRU update
function getFromToolCache(cache: Map<string, ToolCacheEntry>, key: string, ttlMs: number): string | null {
	// Lazy cleanup: check if cached entry is expired
	if (!cleanExpiredToolEntry(cache, key, ttlMs)) {
		const entry = cache.get(key);
		if (entry) {
			// Update lastAccessed for true LRU
			entry.lastAccessed = Date.now();
			return entry.result;
		}
	}
	return null;
}

// PERFORMANCE: Set in cache with automatic LRU enforcement
function setInToolCache(
	cache: Map<string, ToolCacheEntry>,
	key: string,
	result: string,
	maxSize: number,
	cacheName: string,
): void {
	const now = Date.now();
	cache.set(key, {
		result,
		timestamp: now,
		lastAccessed: now,
	});
	enforceToolCacheSizeLimit(cache, maxSize, cacheName);
}

// Zod schema for SQL query execution
const ExecuteSqlInputSchema = z.object({
	query: z.string().min(1).describe('The SQL query to execute'),
});

// Zod schema for version check
const GetVersionInputSchema = z.object({});

// Zod schema for list tables
const ListTablesInputSchema = z.object({
	schema_name: z.string().optional().describe('Optional schema name to filter tables (e.g., "dbo", "sys")'),
});

// Zod schema for get table schema
const GetTableSchemaInputSchema = z.object({
	table_name: z.string().min(1).describe('The name of the table to get schema information for'),
	schema_name: z.string().optional().describe('Optional schema name (default: "dbo")'),
});

// Zod schema for get foreign keys
const GetForeignKeysInputSchema = z.object({
	table_name: z.string().optional().describe('Optional table name to filter foreign keys for a specific table'),
	schema_name: z.string().optional().describe('Optional schema name to filter foreign keys (default: all schemas)'),
});

// Zod schema for search columns
const SearchColumnsInputSchema = z.object({
	column_name: z.string().min(1).describe('The column name to search for (supports partial matching with LIKE pattern)'),
	schema_name: z.string().optional().describe('Optional schema name to limit search scope'),
});

// Zod schema for get table relationships
const GetTableRelationshipsInputSchema = z.object({
	table_name: z.string().min(1).describe('The name of the table to get relationships for'),
	schema_name: z.string().optional().describe('Optional schema name (default: "dbo")'),
});

// Zod schema for get table indexes
const GetTableIndexesInputSchema = z.object({
	table_name: z.string().min(1).describe('The name of the table to get indexes for'),
	schema_name: z.string().optional().describe('Optional schema name (default: "dbo")'),
});

export const MssqlTools = {
	getToolDefinitions(): Tool[] {
		return [
			{
				name: 'exec_sql_csv',
				description: 'Execute a READ-ONLY SQL query on the SQL Server and return results in CSV format. Only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, and DESC queries are allowed. Write operations (INSERT, UPDATE, DELETE, DROP, etc.) are strictly prohibited.',
				inputSchema: z.toJSONSchema(ExecuteSqlInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
			{
				name: 'get_version',
				description: 'Get the SQL Server version information',
				inputSchema: z.toJSONSchema(GetVersionInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
			{
				name: 'list_tables',
				description: 'List all tables and views in the database with their schema, type (TABLE/VIEW), row count, and size information. Optionally filter by schema name.',
				inputSchema: z.toJSONSchema(ListTablesInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
			{
				name: 'get_table_schema',
				description: 'Get detailed schema information for a specific table including column names, data types, nullability, default values, and constraints (PRIMARY KEY, FOREIGN KEY, UNIQUE). Also shows computed columns with their expressions.',
				inputSchema: z.toJSONSchema(GetTableSchemaInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
			{
				name: 'get_foreign_keys',
				description: 'Get all foreign key relationships in the database with detailed constraint information. Optionally filter by table or schema.',
				inputSchema: z.toJSONSchema(GetForeignKeysInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
			{
				name: 'search_columns',
				description: 'Search for columns by name across all tables in the database. Supports partial matching with LIKE patterns (use % as wildcard).',
				inputSchema: z.toJSONSchema(SearchColumnsInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
			{
				name: 'get_table_relationships',
				description: 'Get all parent and child table relationships for a specific table, showing foreign key connections.',
				inputSchema: z.toJSONSchema(GetTableRelationshipsInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
			{
				name: 'get_table_indexes',
				description: 'Get all indexes for a specific table including index type, columns, uniqueness, and whether it is a primary key. Essential for performance troubleshooting.',
				inputSchema: z.toJSONSchema(GetTableIndexesInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
		];
	},

	async handleTool(name: string, args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		if (name === 'get_version') {
			return this.handleGetVersion(pool);
		}

		if (name === 'list_tables') {
			return this.handleListTables(args, pool);
		}

		if (name === 'get_table_schema') {
			return this.handleGetTableSchema(args, pool);
		}

		if (name === 'get_foreign_keys') {
			return this.handleGetForeignKeys(args, pool);
		}

		if (name === 'search_columns') {
			return this.handleSearchColumns(args, pool);
		}

		if (name === 'get_table_relationships') {
			return this.handleGetTableRelationships(args, pool);
		}

		if (name === 'get_table_indexes') {
			return this.handleGetTableIndexes(args, pool);
		}

		if (name === 'exec_sql_csv') {
			return this.handleExecuteSql(args, pool);
		}

		throw new Error(`Unknown tool: ${name}`);
	},

	async handleGetVersion(pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		// PERFORMANCE: Static per-connection cache - version never changes during runtime
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

			// Cache the version permanently per-connection (static cache)
			versionCache.set(pool.name, version);

			if (consola.level >= 0) {
				logger.info('SQL Server version cached');
			}

			return {
				content: [
					{
						type: 'text',
						text: version,
					},
				],
			};
		} catch (error) {
			if (consola.level >= 0) {
				logger.error('Error getting SQL Server version:', error);
			}
			return {
				content: [
					{
						type: 'text',
						text: `Error getting version: ${error instanceof Error ? error.message : 'Unknown error'}`,
					},
				],
			};
		}
	},

	async handleListTables(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const validatedArgs = ListTablesInputSchema.parse(args);
			const schemaFilter = validatedArgs.schema_name;

			// PERFORMANCE: Generate cache key based on schema filter
			const cacheKey = schemaFilter || '_all_schemas_';
			const nsCacheKey = namespaceCacheKey(pool.name, cacheKey);

			// Check cache first
			const cachedResult = getFromToolCache(listTablesCache, nsCacheKey, TABLES_CACHE_TTL_MS);
			if (cachedResult !== null) {
				if (consola.level >= 0) {
					logger.debug(`Returning cached list_tables result for key: ${nsCacheKey}`);
				}
				return {
					content: [
						{
							type: 'text',
							text: cachedResult + '\n\n📋 (Cached result)',
						},
					],
				};
			}

			if (consola.level >= 0) {
				logger.info(`Listing tables and views${schemaFilter ? ` for schema: ${schemaFilter}` : ' (all schemas)'}`);
			}

			let query = 'SELECT t.TABLE_SCHEMA AS [Schema], t.TABLE_NAME AS [Name], t.TABLE_TYPE AS [Type], COALESCE(p.rows, 0) AS [RowCount], COALESCE(CAST(ROUND(((SUM(a.total_pages) * 8) / 1024.00), 2) AS DECIMAL(18,2)), 0.00) AS [SizeMB] FROM INFORMATION_SCHEMA.TABLES t LEFT JOIN sys.tables st ON t.TABLE_NAME = st.name AND t.TABLE_SCHEMA = SCHEMA_NAME(st.schema_id) LEFT JOIN sys.indexes i ON st.object_id = i.object_id AND i.index_id <= 1 LEFT JOIN sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id LEFT JOIN sys.allocation_units a ON p.partition_id = a.container_id WHERE t.TABLE_TYPE IN (\'BASE TABLE\', \'VIEW\')';

			if (schemaFilter) {
				query += ` AND t.TABLE_SCHEMA = '${schemaFilter.replace(/'/g, "''")}'`;
			}

			query += ' GROUP BY t.TABLE_SCHEMA, t.TABLE_NAME, t.TABLE_TYPE, p.rows ORDER BY t.TABLE_SCHEMA, t.TABLE_TYPE, t.TABLE_NAME';

			try {
				const results = await pool.query(query);

				if (!results || results.length === 0) {
					return {
						content: [
							{
								type: 'text',
								text: schemaFilter
									? `No tables or views found in schema: ${schemaFilter}`
									: 'No tables or views found in database',
							},
						],
					};
				}

				const csvText = formatCSV(results);

				// PERFORMANCE: Cache the result
				// Note: list_tables doesn't have a max size limit as we expect only a few different schema filters
				const now = Date.now();
				listTablesCache.set(nsCacheKey, {
					result: csvText,
					timestamp: now,
					lastAccessed: now,
				});

				if (consola.level >= 0) {
					logger.info(`Found ${results.length} table(s)/view(s) - result cached`);
				}

				return {
					content: [
						{
							type: 'text',
							text: csvText,
						},
					],
				};
			} catch (error) {
				if (consola.level >= 0) {
					logger.error('Error executing query:', error);
				}
				return {
					content: [
						{
							type: 'text',
							text: `Error listing tables and views: ${error instanceof Error ? error.message : 'Unknown error'}`,
						},
					],
				};
			}
		} catch (validationError) {
			if (consola.level >= 0) {
				logger.error('Invalid input arguments:', validationError);
			}
			return {
				content: [
					{
						type: 'text',
						text: `Invalid arguments: ${validationError instanceof Error ? validationError.message : 'Unknown validation error'}`,
					},
				],
			};
		}
	},

	async handleGetTableSchema(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const validatedArgs = GetTableSchemaInputSchema.parse(args);
			const tableName = validatedArgs.table_name;
			const schemaName = validatedArgs.schema_name || 'dbo';

			// PERFORMANCE: Generate cache key based on schema and table name
			const cacheKey = `${schemaName}:${tableName}`;
			const nsCacheKey = namespaceCacheKey(pool.name, cacheKey);

			// Check cache first
			const cachedResult = getFromToolCache(tableSchemaCache, nsCacheKey, SCHEMA_CACHE_TTL_MS);
			if (cachedResult !== null) {
				if (consola.level >= 0) {
					logger.debug(`Returning cached table schema for: ${schemaName}.${tableName}`);
				}
				return {
					content: [
						{
							type: 'text',
							text: cachedResult + '\n\n📋 (Cached result)',
						},
					],
				};
			}

			if (consola.level >= 0) {
				logger.info(`Getting schema for table: ${schemaName}.${tableName}`);
			}

			const query = `SELECT c.COLUMN_NAME AS [Column], c.DATA_TYPE AS [DataType], c.CHARACTER_MAXIMUM_LENGTH AS [MaxLength], c.IS_NULLABLE AS [Nullable], c.COLUMN_DEFAULT AS [Default], CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS [PrimaryKey], CASE WHEN fk.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS [ForeignKey], CASE WHEN uq.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS [UniqueKey], CASE WHEN cc.column_id IS NOT NULL THEN 'YES' ELSE 'NO' END AS [Computed], cc.definition AS [ComputedExpression], c.ORDINAL_POSITION AS [Position], CAST(ep.value AS NVARCHAR(4000)) AS [Description] FROM INFORMATION_SCHEMA.COLUMNS c LEFT JOIN (SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc INNER JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA AND tc.TABLE_NAME = ku.TABLE_NAME WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY') pk ON c.TABLE_SCHEMA = pk.TABLE_SCHEMA AND c.TABLE_NAME = pk.TABLE_NAME AND c.COLUMN_NAME = pk.COLUMN_NAME LEFT JOIN (SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc INNER JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA AND tc.TABLE_NAME = ku.TABLE_NAME WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY') fk ON c.TABLE_SCHEMA = fk.TABLE_SCHEMA AND c.TABLE_NAME = fk.TABLE_NAME AND c.COLUMN_NAME = fk.COLUMN_NAME LEFT JOIN (SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc INNER JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA AND tc.TABLE_NAME = ku.TABLE_NAME WHERE tc.CONSTRAINT_TYPE = 'UNIQUE') uq ON c.TABLE_SCHEMA = uq.TABLE_SCHEMA AND c.TABLE_NAME = uq.TABLE_NAME AND c.COLUMN_NAME = uq.COLUMN_NAME LEFT JOIN sys.computed_columns cc ON cc.object_id = OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME) AND cc.name = c.COLUMN_NAME LEFT JOIN sys.columns col ON col.object_id = OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME) AND col.name = c.COLUMN_NAME LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = col.object_id AND ep.minor_id = col.column_id AND ep.name = 'MS_Description' WHERE c.TABLE_SCHEMA = '${schemaName.replace(/'/g, "''")}' AND c.TABLE_NAME = '${tableName.replace(/'/g, "''")}' ORDER BY c.ORDINAL_POSITION`;

			try {
				const results = await pool.query(query);

				if (!results || results.length === 0) {
					return {
						content: [
							{
								type: 'text',
								text: `Table not found: ${schemaName}.${tableName}`,
							},
						],
					};
				}

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

				// PERFORMANCE: Cache the result with LRU eviction
				setInToolCache(tableSchemaCache, nsCacheKey, csvText, SCHEMA_CACHE_MAX_SIZE, 'table_schema');

				if (consola.level >= 0) {
					logger.info(`Found ${results.length} column(s) for table ${schemaName}.${tableName} - result cached`);
				}

				return {
					content: [
						{
							type: 'text',
							text: csvText,
						},
					],
				};
			} catch (error) {
				if (consola.level >= 0) {
					logger.error('Error executing query:', error);
				}
				return {
					content: [
						{
							type: 'text',
							text: `Error getting table schema: ${error instanceof Error ? error.message : 'Unknown error'}`,
						},
					],
				};
			}
		} catch (validationError) {
			if (consola.level >= 0) {
				logger.error('Invalid input arguments:', validationError);
			}
			return {
				content: [
					{
						type: 'text',
						text: `Invalid arguments: ${validationError instanceof Error ? validationError.message : 'Unknown validation error'}`,
					},
				],
			};
		}
	},

	async handleGetForeignKeys(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const validatedArgs = GetForeignKeysInputSchema.parse(args);
			const tableFilter = validatedArgs.table_name;
			const schemaFilter = validatedArgs.schema_name;

			// PERFORMANCE: Generate cache key based on filters
			const cacheKey = `${schemaFilter || '_all_'}:${tableFilter || '_all_'}`;
			const nsCacheKey = namespaceCacheKey(pool.name, cacheKey);

			// Check cache first
			const cachedResult = getFromToolCache(foreignKeysCache, nsCacheKey, FK_CACHE_TTL_MS);
			if (cachedResult !== null) {
				if (consola.level >= 0) {
					logger.debug(`Returning cached foreign keys for: ${cacheKey}`);
				}
				return {
					content: [
						{
							type: 'text',
							text: cachedResult + '\n\n📋 (Cached result)',
						},
					],
				};
			}

			if (consola.level >= 0) {
				logger.info(`Getting foreign keys${tableFilter ? ` for table: ${tableFilter}` : ' (all tables)'}${schemaFilter ? ` in schema: ${schemaFilter}` : ''}`);
			}

			let query = 'SELECT fk.name AS [ConstraintName], OBJECT_SCHEMA_NAME(fk.parent_object_id) AS [ParentSchema], OBJECT_NAME(fk.parent_object_id) AS [ParentTable], COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS [ParentColumn], OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS [ReferencedSchema], OBJECT_NAME(fk.referenced_object_id) AS [ReferencedTable], COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS [ReferencedColumn], CASE fk.delete_referential_action WHEN 0 THEN \'NO ACTION\' WHEN 1 THEN \'CASCADE\' WHEN 2 THEN \'SET NULL\' WHEN 3 THEN \'SET DEFAULT\' END AS [OnDelete], CASE fk.update_referential_action WHEN 0 THEN \'NO ACTION\' WHEN 1 THEN \'CASCADE\' WHEN 2 THEN \'SET NULL\' WHEN 3 THEN \'SET DEFAULT\' END AS [OnUpdate] FROM sys.foreign_keys fk INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id WHERE 1=1';

			if (schemaFilter) {
				query += ` AND OBJECT_SCHEMA_NAME(fk.parent_object_id) = '${schemaFilter.replace(/'/g, "''")}'`;
			}

			if (tableFilter) {
				query += ` AND OBJECT_NAME(fk.parent_object_id) = '${tableFilter.replace(/'/g, "''")}'`;
			}

			query += ' ORDER BY [ParentSchema], [ParentTable], [ConstraintName]';

			try {
				const results = await pool.query(query);

				if (!results || results.length === 0) {
					return {
						content: [
							{
								type: 'text',
								text: tableFilter
									? `No foreign keys found for table: ${tableFilter}`
									: 'No foreign keys found in database',
							},
						],
					};
				}

				const csvText = formatCSV(results);

				// PERFORMANCE: Cache the result with LRU eviction
				setInToolCache(foreignKeysCache, nsCacheKey, csvText, FK_CACHE_MAX_SIZE, 'foreign_keys');

				if (consola.level >= 0) {
					logger.info(`Found ${results.length} foreign key(s) - result cached`);
				}

				return {
					content: [
						{
							type: 'text',
							text: csvText,
						},
					],
				};
			} catch (error) {
				if (consola.level >= 0) {
					logger.error('Error executing query:', error);
				}
				return {
					content: [
						{
							type: 'text',
							text: `Error getting foreign keys: ${error instanceof Error ? error.message : 'Unknown error'}`,
						},
					],
				};
			}
		} catch (validationError) {
			if (consola.level >= 0) {
				logger.error('Invalid input arguments:', validationError);
			}
			return {
				content: [
					{
						type: 'text',
						text: `Invalid arguments: ${validationError instanceof Error ? validationError.message : 'Unknown validation error'}`,
					},
				],
			};
		}
	},

	async handleSearchColumns(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const validatedArgs = SearchColumnsInputSchema.parse(args);
			const columnName = validatedArgs.column_name;
			const schemaFilter = validatedArgs.schema_name;

			// PERFORMANCE: Generate cache key based on normalized search term
			// Normalize to lowercase for better cache hit rate
			const normalizedColumn = columnName.toLowerCase().trim();
			const cacheKey = `${schemaFilter || '_all_'}:${normalizedColumn}`;
			const nsCacheKey = namespaceCacheKey(pool.name, cacheKey);

			// Check cache first
			const cachedResult = getFromToolCache(columnsCache, nsCacheKey, COLUMNS_CACHE_TTL_MS);
			if (cachedResult !== null) {
				if (consola.level >= 0) {
					logger.debug(`Returning cached column search for: ${cacheKey}`);
				}
				return {
					content: [
						{
							type: 'text',
							text: cachedResult + '\n\n📋 (Cached result)',
						},
					],
				};
			}

			if (consola.level >= 0) {
				logger.info(`Searching for column: ${columnName}${schemaFilter ? ` in schema: ${schemaFilter}` : ''}`);
			}

			let query = 'SELECT TABLE_SCHEMA AS [Schema], TABLE_NAME AS [Table], COLUMN_NAME AS [Column], DATA_TYPE AS [DataType], CHARACTER_MAXIMUM_LENGTH AS [MaxLength], IS_NULLABLE AS [Nullable], ORDINAL_POSITION AS [Position] FROM INFORMATION_SCHEMA.COLUMNS WHERE COLUMN_NAME LIKE \'%' + columnName.replace(/'/g, "''") + '%\'';

			if (schemaFilter) {
				query += ` AND TABLE_SCHEMA = '${schemaFilter.replace(/'/g, "''")}'`;
			}

			query += ' ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION';

			try {
				const results = await pool.query(query);

				if (!results || results.length === 0) {
					return {
						content: [
							{
								type: 'text',
								text: `No columns found matching: ${columnName}`,
							},
						],
					};
				}

				const csvText = formatCSV(results);

				// PERFORMANCE: Cache the result with LRU eviction
				setInToolCache(columnsCache, nsCacheKey, csvText, COLUMNS_CACHE_MAX_SIZE, 'search_columns');

				if (consola.level >= 0) {
					logger.info(`Found ${results.length} column(s) matching: ${columnName} - result cached`);
				}

				return {
					content: [
						{
							type: 'text',
							text: csvText,
						},
					],
				};
			} catch (error) {
				if (consola.level >= 0) {
					logger.error('Error executing query:', error);
				}
				return {
					content: [
						{
							type: 'text',
							text: `Error searching columns: ${error instanceof Error ? error.message : 'Unknown error'}`,
						},
					],
				};
			}
		} catch (validationError) {
			if (consola.level >= 0) {
				logger.error('Invalid input arguments:', validationError);
			}
			return {
				content: [
					{
						type: 'text',
						text: `Invalid arguments: ${validationError instanceof Error ? validationError.message : 'Unknown validation error'}`,
					},
				],
			};
		}
	},

	async handleGetTableRelationships(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const validatedArgs = GetTableRelationshipsInputSchema.parse(args);
			const tableName = validatedArgs.table_name;
			const schemaName = validatedArgs.schema_name || 'dbo';

			// PERFORMANCE: Generate cache key based on schema and table name
			const cacheKey = `${schemaName}:${tableName}`;
			const nsCacheKey = namespaceCacheKey(pool.name, cacheKey);

			// Check cache first
			const cachedResult = getFromToolCache(relationshipsCache, nsCacheKey, RELATIONSHIPS_CACHE_TTL_MS);
			if (cachedResult !== null) {
				if (consola.level >= 0) {
					logger.debug(`Returning cached table relationships for: ${schemaName}.${tableName}`);
				}
				return {
					content: [
						{
							type: 'text',
							text: cachedResult + '\n\n📋 (Cached result)',
						},
					],
				};
			}

			if (consola.level >= 0) {
				logger.info(`Getting relationships for table: ${schemaName}.${tableName}`);
			}

			const query = `SELECT \'PARENT\' AS [RelationType], fk.name AS [ConstraintName], OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS [RelatedSchema], OBJECT_NAME(fk.referenced_object_id) AS [RelatedTable], COL_NAME(fkc.parent_column_id, fkc.parent_column_id) AS [ThisColumn], COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS [RelatedColumn] FROM sys.foreign_keys fk INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id WHERE OBJECT_SCHEMA_NAME(fk.parent_object_id) = '${schemaName.replace(/'/g, "''")}' AND OBJECT_NAME(fk.parent_object_id) = '${tableName.replace(/'/g, "''")}' UNION ALL SELECT \'CHILD\' AS [RelationType], fk.name AS [ConstraintName], OBJECT_SCHEMA_NAME(fk.parent_object_id) AS [RelatedSchema], OBJECT_NAME(fk.parent_object_id) AS [RelatedTable], COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS [ThisColumn], COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS [RelatedColumn] FROM sys.foreign_keys fk INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id WHERE OBJECT_SCHEMA_NAME(fk.referenced_object_id) = '${schemaName.replace(/'/g, "''")}' AND OBJECT_NAME(fk.referenced_object_id) = '${tableName.replace(/'/g, "''")}' ORDER BY [RelationType], [RelatedSchema], [RelatedTable]`;

			try {
				const results = await pool.query(query);

				if (!results || results.length === 0) {
					return {
						content: [
							{
								type: 'text',
								text: `No relationships found for table: ${schemaName}.${tableName}`,
							},
						],
					};
				}

				const csvText = formatCSV(results);

				// PERFORMANCE: Cache the result with LRU eviction
				setInToolCache(relationshipsCache, nsCacheKey, csvText, RELATIONSHIPS_CACHE_MAX_SIZE, 'table_relationships');

				if (consola.level >= 0) {
					logger.info(`Found ${results.length} relationship(s) for table ${schemaName}.${tableName} - result cached`);
				}

				return {
					content: [
						{
							type: 'text',
							text: csvText,
						},
					],
				};
			} catch (error) {
				if (consola.level >= 0) {
					logger.error('Error executing query:', error);
				}
				return {
					content: [
						{
							type: 'text',
							text: `Error getting table relationships: ${error instanceof Error ? error.message : 'Unknown error'}`,
						},
					],
				};
			}
		} catch (validationError) {
			if (consola.level >= 0) {
				logger.error('Invalid input arguments:', validationError);
			}
			return {
				content: [
					{
						type: 'text',
						text: `Invalid arguments: ${validationError instanceof Error ? validationError.message : 'Unknown validation error'}`,
					},
				],
			};
		}
	},

	async handleGetTableIndexes(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const validatedArgs = GetTableIndexesInputSchema.parse(args);
			const tableName = validatedArgs.table_name;
			const schemaName = validatedArgs.schema_name || 'dbo';

			// PERFORMANCE: Generate cache key based on schema and table name
			const cacheKey = `${schemaName}:${tableName}`;
			const nsCacheKey = namespaceCacheKey(pool.name, cacheKey);

			// Check cache first
			const cachedResult = getFromToolCache(indexesCache, nsCacheKey, INDEXES_CACHE_TTL_MS);
			if (cachedResult !== null) {
				if (consola.level >= 0) {
					logger.debug(`Returning cached indexes for: ${schemaName}.${tableName}`);
				}
				return {
					content: [
						{
							type: 'text',
							text: cachedResult + '\n\n📋 (Cached result)',
						},
					],
				};
			}

			if (consola.level >= 0) {
				logger.info(`Getting indexes for table: ${schemaName}.${tableName}`);
			}

			const query = `SELECT i.name AS [IndexName], i.type_desc AS [IndexType], CASE WHEN i.is_unique = 1 THEN \'YES\' ELSE \'NO\' END AS [IsUnique], CASE WHEN i.is_primary_key = 1 THEN \'YES\' ELSE \'NO\' END AS [IsPrimaryKey], c.name AS [ColumnName], ic.key_ordinal AS [KeyOrdinal], CASE WHEN ic.is_included_column = 1 THEN \'YES\' ELSE \'NO\' END AS [IsIncluded] FROM sys.indexes i INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id INNER JOIN sys.tables t ON i.object_id = t.object_id WHERE SCHEMA_NAME(t.schema_id) = '${schemaName.replace(/'/g, "''")}' AND t.name = '${tableName.replace(/'/g, "''")}' ORDER BY i.name, ic.key_ordinal`;

			try {
				const results = await pool.query(query);

				if (!results || results.length === 0) {
					return {
						content: [
							{
								type: 'text',
								text: `No indexes found for table: ${schemaName}.${tableName}`,
							},
						],
					};
				}

				const csvText = formatCSV(results);

				// PERFORMANCE: Cache the result with LRU eviction
				setInToolCache(indexesCache, nsCacheKey, csvText, INDEXES_CACHE_MAX_SIZE, 'table_indexes');

				if (consola.level >= 0) {
					logger.info(`Found ${results.length} index column(s) for table ${schemaName}.${tableName} - result cached`);
				}

				return {
					content: [
						{
							type: 'text',
							text: csvText,
						},
					],
				};
			} catch (error) {
				if (consola.level >= 0) {
					logger.error('Error executing query:', error);
				}
				return {
					content: [
						{
							type: 'text',
							text: `Error getting table indexes: ${error instanceof Error ? error.message : 'Unknown error'}`,
						},
					],
				};
			}
		} catch (validationError) {
			if (consola.level >= 0) {
				logger.error('Invalid input arguments:', validationError);
			}
			return {
				content: [
					{
						type: 'text',
						text: `Invalid arguments: ${validationError instanceof Error ? validationError.message : 'Unknown validation error'}`,
					},
				],
			};
		}
	},

	async handleExecuteSql(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		// Validate input using Zod schema
		try {
			const validatedArgs = ExecuteSqlInputSchema.parse(args);
			const query = validatedArgs.query;

			// CRITICAL: Validate that query is read-only (this MCP server is READ-ONLY by design)
			if (!isReadOnlyQuery(query)) {
				return {
					content: [
						{
							type: 'text',
							text: 'Error: This MCP server is READ-ONLY. Only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, and DESC queries are permitted. Write operations (INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, etc.) are strictly prohibited and blocked before execution.',
						},
					],
				};
			}

			// PERFORMANCE: Check query cache first with lazy cleanup
			const cacheKey = namespaceCacheKey(pool.name, getCacheKey(query));
			const now = Date.now();

			// Lazy cleanup: check if cached entry is expired
			if (!cleanExpiredEntry(cacheKey)) {
				// Entry exists and is not expired
				const cachedEntry = queryCache.get(cacheKey);
				if (cachedEntry) {
					// Update lastAccessed for true LRU
					cachedEntry.lastAccessed = now;

					if (consola.level >= 0) {
						const cacheAgeSeconds = Math.round((now - cachedEntry.timestamp) / 1000);
						logger.debug(`Returning cached query result (age: ${cacheAgeSeconds}s)`);
					}

					return {
						content: [
							{
								type: 'text',
								text: cachedEntry.result + '\n\n📋 (Cached result)',
							},
						],
					};
				}
			}

			// PERFORMANCE: Only compute log message if logging is enabled
			if (consola.level >= 0) {
				const truncatedQuery = query.length > 100 ? query.substring(0, 100) + '...' : query;
				logger.info(`Executing READ-ONLY SQL query: ${truncatedQuery}`);
			}

			try {
				// Execute read-only query
				let results = await pool.query(query);

				// Handle empty results
				if (!results || results.length === 0) {
					const message = query.trim().toUpperCase().startsWith('SELECT')
						? 'No results found'
						: 'Query executed successfully but returned no results.';

					return {
						content: [
							{
								type: 'text',
								text: message,
							},
						],
					};
				}

				// PERFORMANCE: Check result size and apply limits
				const resultCount = results.length;
				let warningMessage = '';

				if (resultCount > MAX_RESULT_ROWS) {
					// Truncate results to MAX_RESULT_ROWS
					results = results.slice(0, MAX_RESULT_ROWS);
					warningMessage = `\n\n⚠️ WARNING: Result set truncated from ${resultCount} to ${MAX_RESULT_ROWS} rows. Consider adding LIMIT/TOP clause to your query for better performance.`;

					if (consola.level >= 0) {
						logger.warn(`Large result set truncated: ${resultCount} rows -> ${MAX_RESULT_ROWS} rows`);
					}
				} else if (resultCount > WARN_RESULT_ROWS) {
					// Just warn, don't truncate
					warningMessage = `\n\n⚠️ Note: Large result set (${resultCount} rows). Consider using LIMIT/TOP for better performance.`;

					if (consola.level >= 0) {
						logger.warn(`Large result set: ${resultCount} rows`);
					}
				}

				// PERFORMANCE: Memory-efficient CSV formatting using array join (O(n) instead of O(n²))
				const resultText = formatCSV(results, warningMessage);

				// PERFORMANCE: Cache the query result with LRU tracking
				queryCache.set(cacheKey, {
					result: resultText,
					timestamp: now,
					lastAccessed: now,
				});
				enforceCacheSizeLimit(); // Ensure we don't exceed cache size with LRU eviction

				if (consola.level >= 0) {
					logger.debug(`Query result cached (cache size: ${queryCache.size}/${QUERY_CACHE_MAX_SIZE})`);
				}

				return {
					content: [
						{
							type: 'text',
							text: resultText,
						},
					],
				};
			} catch (error) {
				// PERFORMANCE: Only log error details if logging is enabled
				if (consola.level >= 0) {
					logger.error('Error executing READ-ONLY SQL:', query, error);
				}

				const errorMessage = error instanceof Error ? error.message : 'Unknown error';

				// PERFORMANCE: Compute lowercase once for multiple checks
				const lowerErrorMsg = errorMessage.toLowerCase();
				const isWriteAttempt =
					lowerErrorMsg.includes('read only')
					|| lowerErrorMsg.includes('cannot execute')
					|| lowerErrorMsg.includes('not allowed')
					|| lowerErrorMsg.includes('insert')
					|| lowerErrorMsg.includes('update')
					|| lowerErrorMsg.includes('delete');

				if (isWriteAttempt) {
					return {
						content: [
							{
								type: 'text',
								text: `Error: Write operation blocked. This MCP server is READ-ONLY and does not allow data modifications. Original error: ${errorMessage}`,
							},
						],
					};
				}

				return {
					content: [
						{
							type: 'text',
							text: `Error executing query: ${errorMessage}`,
						},
					],
				};
			}
		} catch (validationError) {
			if (consola.level >= 0) {
				logger.error('Invalid input arguments:', validationError);
			}
			return {
				content: [
					{
						type: 'text',
						text: `Invalid arguments: ${validationError instanceof Error ? validationError.message : 'Unknown validation error'}`,
					},
				],
			};
		}
	},
};
