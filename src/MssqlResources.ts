import type { Resource, TextResourceContents } from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import { validateTableName } from './server/config.js';
import type { ConnectionPool } from './server/connection.js';
import { formatCSV } from './utils/csv.js';

const logger = consola.withTag('mssql-resources');

// PERFORMANCE: TTL-based cache for resource listing (5 minutes)
interface ResourceCache {
	resources: Resource[];
	timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let resourceCache: ResourceCache | null = null;

// PERFORMANCE: Configurable resource data limit from environment
const RESOURCE_DATA_LIMIT = parseInt(process.env.MSSQL_RESOURCE_LIMIT || '100', 10);

export const MssqlResources = {
	async getResourceDefinitions(pool: ConnectionPool): Promise<Resource[]> {
		// PERFORMANCE: Check cache first
		const now = Date.now();
		if (resourceCache && now - resourceCache.timestamp < CACHE_TTL_MS) {
			// PERFORMANCE: Only compute cache age if logging is enabled
			if (consola.level >= 0) {
				const cacheAgeSeconds = Math.round((now - resourceCache.timestamp) / 1000);
				logger.debug(`Returning cached resources (age: ${cacheAgeSeconds}s)`);
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
				if (consola.level >= 0) {
					logger.warn('Returning stale cache due to error');
				}
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

			// PERFORMANCE: Use configurable limit for resource data
			const results = await pool.query(`SELECT TOP ${RESOURCE_DATA_LIMIT} * FROM ${safeTableName}`);

			if (results.length === 0) {
				return {
					uri,
					mimeType: 'text/plain',
					text: `No data found in table: ${tableName}`,
				};
			}

			// PERFORMANCE: Memory-efficient CSV formatting with proper escaping
			let paginationWarning = '';
			if (results.length === RESOURCE_DATA_LIMIT) {
				paginationWarning = `\n\n⚠️ Note: Showing first ${RESOURCE_DATA_LIMIT} rows only. Set MSSQL_RESOURCE_LIMIT environment variable to adjust.`;
			}

			const resultText = formatCSV(results, paginationWarning);

			return {
				uri,
				mimeType: 'text/plain',
				text: resultText,
			};
		} catch (error) {
			// PERFORMANCE: Avoid string interpolation in error logging
			if (consola.level >= 0) {
				logger.error('Database error reading resource:', uri, error);
			}
			throw new Error(`Database error: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	},

	clearCaches(_connectionName?: string): number {
		const n = resourceCache ? 1 : 0;
		resourceCache = null;
		return n;
	},
};
