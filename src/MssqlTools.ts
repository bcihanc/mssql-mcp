import type { TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import crypto from 'node:crypto';
import { z } from 'zod/v4';
import { isReadOnlyQuery, validateTableName } from './server/config';
import type { ConnectionPool } from './server/connection';
import { formatCSV } from './utils/csv';

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

// Zod schema for SQL query execution
const ExecuteSqlInputSchema = z.object({
	query: z.string().min(1).describe('The SQL query to execute'),
});

// Zod schema for version check
const GetVersionInputSchema = z.object({});

// Zod schema for table schema introspection
const GetTableSchemaInputSchema = z.object({
	tableName: z.string().min(1).describe('The name of the table to get schema information for (supports schema.table format)'),
	includeIndexes: z.boolean().optional().describe('Include index information (default: false)'),
});

export const MssqlTools = {
	getToolDefinitions(): Tool[] {
		return [
			{
				name: 'exec_sql_csv',
				description: 'Execute a READ-ONLY SQL query on the SQL Server and return results in CSV format. Only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, and DESC queries are allowed. Write operations (INSERT, UPDATE, DELETE, DROP, etc.) are strictly prohibited.',
				inputSchema: z.toJSONSchema(ExecuteSqlInputSchema) as any,
			},
			{
				name: 'get_table_schema',
				description: 'Get detailed schema information for a table including column names, data types, nullability, and optionally indexes. This helps you understand table structure before writing queries. Use this tool BEFORE writing SELECT queries to avoid column name errors.',
				inputSchema: z.toJSONSchema(GetTableSchemaInputSchema) as any,
			},
			{
				name: 'get_version',
				description: 'Get the SQL Server version information',
				inputSchema: z.toJSONSchema(GetVersionInputSchema) as any,
			},
		];
	},

	async handleTool(name: string, args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		if (name === 'get_version') {
			return this.handleGetVersion(pool);
		}

		if (name === 'get_table_schema') {
			return this.handleGetTableSchema(args, pool);
		}

		if (name === 'exec_sql_csv') {
			return this.handleExecuteSql(args, pool);
		}

		throw new Error(`Unknown tool: ${name}`);
	},

	async handleGetVersion(pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const results = await pool.query('SELECT @@VERSION AS version');
			const version = results[0]?.version || 'Unknown';

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

	async handleGetTableSchema(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const validatedArgs = GetTableSchemaInputSchema.parse(args);
			const { tableName, includeIndexes = false } = validatedArgs;

			// Validate and escape table name to prevent SQL injection
			const safeTableName = validateTableName(tableName);

			// Parse schema and table parts for INFORMATION_SCHEMA query
			const parts = tableName.split('.');
			const schemaName = parts.length === 2 ? parts[0] : 'dbo';
			const actualTableName = parts.length === 2 ? parts[1] : tableName;

			if (consola.level >= 0) {
				logger.info(`Getting schema for table: ${safeTableName}`);
			}

			try {
				// Get column information from INFORMATION_SCHEMA
				const columnQuery = `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = '${schemaName}' AND TABLE_NAME = '${actualTableName}' ORDER BY ORDINAL_POSITION`;

				const columns = await pool.query(columnQuery);

				if (!columns || columns.length === 0) {
					return {
						content: [
							{
								type: 'text',
								text: `Table not found: ${tableName}\n\nPlease verify the table name and schema. Use format: schema.table or just table for dbo schema.`,
							},
						],
					};
				}

				// Build schema information text
				let schemaText = `📋 Table Schema: ${safeTableName}\n\n`;
				schemaText += `Total Columns: ${columns.length}\n\n`;
				schemaText += formatCSV(columns);

				// Get index information if requested
				if (includeIndexes) {
					const indexQuery = `SELECT i.name AS INDEX_NAME, i.type_desc AS INDEX_TYPE, i.is_unique AS IS_UNIQUE, i.is_primary_key AS IS_PRIMARY_KEY, COL_NAME(ic.object_id, ic.column_id) AS COLUMN_NAME FROM sys.indexes i INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id WHERE i.object_id = OBJECT_ID('${safeTableName}') ORDER BY i.name, ic.key_ordinal`;

					const indexes = await pool.query(indexQuery);

					if (indexes && indexes.length > 0) {
						schemaText += '\n\n📊 Indexes:\n\n';
						schemaText += formatCSV(indexes);
					} else {
						schemaText += '\n\nℹ️ No indexes found for this table.';
					}
				}

				return {
					content: [
						{
							type: 'text',
							text: schemaText,
						},
					],
				};
			} catch (error) {
				if (consola.level >= 0) {
					logger.error('Error getting table schema:', error);
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
				logger.error('Invalid input arguments for get_table_schema:', validationError);
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
			const cacheKey = getCacheKey(query);
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
