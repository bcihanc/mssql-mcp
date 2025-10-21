import type { TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import { z } from 'zod/v4';
import { isReadOnlyQuery } from './server/config';
import type { ConnectionPool } from './server/connection';

const logger = consola.withTag('mssql-tools');

// PERFORMANCE: Configurable result size limits from environment
const MAX_RESULT_ROWS = parseInt(process.env.MSSQL_MAX_ROWS || '10000', 10);
const WARN_RESULT_ROWS = parseInt(process.env.MSSQL_WARN_ROWS || '5000', 10);

// PERFORMANCE: Query result caching with TTL
interface QueryCacheEntry {
	result: string;
	timestamp: number;
}

const QUERY_CACHE_TTL_MS = parseInt(process.env.MSSQL_CACHE_TTL || '60000', 10); // Default 60 seconds
const QUERY_CACHE_MAX_SIZE = parseInt(process.env.MSSQL_CACHE_SIZE || '100', 10); // Max 100 queries
const queryCache = new Map<string, QueryCacheEntry>();

// Helper to generate cache key (normalized query)
function getCacheKey(query: string): string {
	return query.trim().toUpperCase().replace(/\s+/g, ' ');
}

// Helper to clean expired cache entries
function cleanExpiredCache(): void {
	const now = Date.now();
	for (const [key, entry] of queryCache.entries()) {
		if (now - entry.timestamp > QUERY_CACHE_TTL_MS) {
			queryCache.delete(key);
		}
	}
}

// Helper to enforce cache size limit (LRU-like eviction)
function enforceCacheSizeLimit(): void {
	if (queryCache.size > QUERY_CACHE_MAX_SIZE) {
		// Delete oldest entries
		const entriesToDelete = queryCache.size - QUERY_CACHE_MAX_SIZE;
		let deleted = 0;
		for (const key of queryCache.keys()) {
			queryCache.delete(key);
			deleted++;
			if (deleted >= entriesToDelete) break;
		}
	}
}

// Zod schema for SQL query execution
const ExecuteSqlInputSchema = z.object({
	query: z.string().min(1).describe('The SQL query to execute'),
});

// Zod schema for version check
const GetVersionInputSchema = z.object({});

export const MssqlTools = {
	getToolDefinitions(): Tool[] {
		return [
			{
				name: 'exec_sql_csv',
				description: 'Execute a READ-ONLY SQL query on the SQL Server and return results in CSV format. Only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, and DESC queries are allowed. Write operations (INSERT, UPDATE, DELETE, DROP, etc.) are strictly prohibited.',
				inputSchema: z.toJSONSchema(ExecuteSqlInputSchema) as any,
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

			// PERFORMANCE: Check query cache first
			const cacheKey = getCacheKey(query);
			const now = Date.now();
			const cachedEntry = queryCache.get(cacheKey);

			if (cachedEntry && now - cachedEntry.timestamp < QUERY_CACHE_TTL_MS) {
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

				// PERFORMANCE: Memory-efficient CSV formatting with streaming approach
				const columns = Object.keys(results[0]);
				const needsQuotingRegex = /[,"\n\r]/;

				// Build CSV string efficiently (avoid intermediate array)
				let resultText = columns.join(',');

				for (const row of results) {
					resultText += '\n';
					resultText += columns
						.map((col) => {
							const value = row[col];
							if (value === null || value === undefined) return '';

							// PERFORMANCE: Single regex test instead of 3 includes() calls
							const strValue = String(value);
							if (needsQuotingRegex.test(strValue)) {
								return `"${strValue.replace(/"/g, '""')}"`;
							}
							return strValue;
						})
						.join(',');
				}

				resultText += warningMessage;

				// PERFORMANCE: Cache the query result
				cleanExpiredCache(); // Clean up expired entries first
				queryCache.set(cacheKey, {
					result: resultText,
					timestamp: now,
				});
				enforceCacheSizeLimit(); // Ensure we don't exceed cache size

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
