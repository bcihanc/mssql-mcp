import type { Resource, TextResourceContents } from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import { validateTableName } from './server/config';
import type { ConnectionPool } from './server/connection';

const logger = consola.withTag('mssql-resources');

// PERFORMANCE: TTL-based cache for resource listing (5 minutes)
interface ResourceCache {
	resources: Resource[];
	timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let resourceCache: ResourceCache | null = null;

export const MssqlResources = {
	async getResourceDefinitions(pool: ConnectionPool): Promise<Resource[]> {
		// PERFORMANCE: Check cache first
		const now = Date.now();
		if (resourceCache && now - resourceCache.timestamp < CACHE_TTL_MS) {
			if (consola.level >= 0) {
				logger.debug(`Returning cached resources (age: ${Math.round((now - resourceCache.timestamp) / 1000)}s)`);
			}
			return resourceCache.resources;
		}

		try {
			const results = await pool.query(`
        SELECT TABLE_NAME
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE'
      `);

			// Only log if not in STDIO mode
			if (consola.level >= 0) {
				logger.info(`Found ${results.length} tables (cache updated)`);
			}

			const resources: Resource[] = [];
			for (const table of results) {
				const tableName = table.TABLE_NAME || table.table_name;
				resources.push({
					uri: `mssql://${tableName}/data`,
					name: `Table: ${tableName}`,
					mimeType: 'text/plain',
					description: `Data in table: ${tableName}`,
				});
			}

			// PERFORMANCE: Update cache
			resourceCache = {
				resources,
				timestamp: now,
			};

			return resources;
		} catch (error) {
			if (consola.level >= 0) {
				logger.error('Failed to list resources:', error);
			}
			// Return cached data even if expired, better than nothing
			if (resourceCache) {
				logger.warn('Returning stale cache due to error');
				return resourceCache.resources;
			}
			return [];
		}
	},

	async handleResource(uri: string, pool: ConnectionPool): Promise<TextResourceContents> {
		// Only log if not in STDIO mode
		if (consola.level >= 0) {
			logger.info(`Reading resource: ${uri}`);
		}

		if (!uri.startsWith('mssql://')) {
			throw new Error(`Invalid URI scheme: ${uri}`);
		}

		const uriPath = uri.substring(8); // Remove 'mssql://' prefix
		const parts = uriPath.split('/');
		const tableName = parts[0];

		if (!tableName) {
			throw new Error(`Invalid URI format: ${uri}`);
		}

		try {
			// Validate table name to prevent SQL injection
			const safeTableName = validateTableName(tableName);

			// Use TOP 100 for MSSQL (equivalent to LIMIT in other databases)
			const results = await pool.query(`SELECT TOP 100 * FROM ${safeTableName}`);

			if (results.length === 0) {
				return {
					uri,
					mimeType: 'text/plain',
					text: `No data found in table: ${tableName}`,
				};
			}

			// Get column names from first row
			const columns = Object.keys(results[0]);
			const csvRows = results.map((row: any) => columns.map((col) => String(row[col] ?? '')).join(','));
			const resultText = [columns.join(','), ...csvRows].join('\n');

			return {
				uri,
				mimeType: 'text/plain',
				text: resultText,
			};
		} catch (error) {
			if (consola.level >= 0) {
				logger.error(`Database error reading resource ${uri}:`, error);
			}
			throw new Error(`Database error: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	},
};
