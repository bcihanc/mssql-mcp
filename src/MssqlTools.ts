import type { TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import { z } from 'zod/v4';
import { getMssqlConfig, isReadOnlyQuery } from './server/config';
import type { ConnectionPool } from './server/connection';

const logger = consola.withTag('mssql-tools');

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

			// Only log if not in STDIO mode
			if (consola.level >= 0) {
				logger.info(
					`Executing READ-ONLY SQL query: ${query.substring(0, 100)}${query.length > 100 ? '...' : ''}`,
				);
			}

			try {
				// Execute read-only query
				const results = await pool.query(query);

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

				// Format results as CSV
				const columns = Object.keys(results[0]);
				// PERFORMANCE: Compile regex once outside the loop
				const needsQuotingRegex = /[,"\n\r]/;

				const csvRows = results.map((row: any) =>
					columns
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
						.join(','),
				);
				const resultText = [columns.join(','), ...csvRows].join('\n');

				return {
					content: [
						{
							type: 'text',
							text: resultText,
						},
					],
				};
			} catch (error) {
				if (consola.level >= 0) {
					logger.error(`Error executing READ-ONLY SQL '${query}':`, error);
				}

				const errorMessage = error instanceof Error ? error.message : 'Unknown error';

				// Check if this was a write operation that bypassed validation
				const isWriteAttempt =
					errorMessage.toLowerCase().includes('read only')
					|| errorMessage.toLowerCase().includes('cannot execute')
					|| errorMessage.toLowerCase().includes('not allowed')
					|| errorMessage.toLowerCase().includes('insert')
					|| errorMessage.toLowerCase().includes('update')
					|| errorMessage.toLowerCase().includes('delete');

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
