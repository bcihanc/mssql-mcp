import type { Resource, TextResourceContents } from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import { validateTableName } from './server/config.js';
import type { ConnectionPool } from './server/connection.js';
import type { ConnectionRegistry } from './server/ConnectionRegistry.js';
import { formatCSV } from './utils/csv.js';

const logger = consola.withTag('mssql-resources');

// PERFORMANCE: TTL-based cache for resource listing (5 minutes), one entry per connection
interface ResourceCache {
	resources: Resource[];
	timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const resourceCaches = new Map<string, ResourceCache>();

// PERFORMANCE: Configurable resource data limit from environment
const RESOURCE_DATA_LIMIT = parseInt(process.env.MSSQL_RESOURCE_LIMIT || '100', 10);

async function listTablesFor(pool: ConnectionPool, connectionName: string, multi: boolean): Promise<Resource[]> {
	const now = Date.now();
	const cached = resourceCaches.get(connectionName);
	if (cached && now - cached.timestamp < CACHE_TTL_MS) {
		if (consola.level >= 0) {
			logger.debug(`Returning cached resources for ${connectionName} (age: ${Math.round((now - cached.timestamp) / 1000)}s)`);
		}
		return cached.resources;
	}

	try {
		const results = await pool.query(`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'`);
		if (consola.level >= 0) {
			logger.info(`Found ${results.length} tables on ${connectionName} (cache updated)`);
		}

		const resources: Resource[] = [];
		for (const table of results) {
			const tableName = table.TABLE_NAME || table.table_name;
			resources.push({
				uri: multi ? `mssql://${connectionName}/${tableName}/data` : `mssql://${tableName}/data`,
				name: multi ? `Table: ${connectionName}/${tableName}` : `Table: ${tableName}`,
				mimeType: 'text/plain',
				description: multi ? `Data in table ${tableName} (connection: ${connectionName})` : `Data in table: ${tableName}`,
			});
		}

		resourceCaches.set(connectionName, { resources, timestamp: now });
		return resources;
	} catch (error) {
		if (consola.level >= 0) {
			logger.error(`Failed to list resources for ${connectionName}:`, error);
		}
		// Per-connection error isolation: stale cache if present, else skip this connection
		if (cached) {
			if (consola.level >= 0) logger.warn(`Returning stale cache for ${connectionName} due to error`);
			return cached.resources;
		}
		return [];
	}
}

export const MssqlResources = {
	async getResourceDefinitions(registry: ConnectionRegistry): Promise<Resource[]> {
		const infos = registry.list();
		const multi = infos.length > 1;
		const all: Resource[] = [];
		for (const info of infos) {
			all.push(...(await listTablesFor(registry.get(info.name), info.name, multi)));
		}
		return all;
	},

	async handleResource(uri: string, registry: ConnectionRegistry): Promise<TextResourceContents> {
		// Only log if not in STDIO mode
		if (consola.level >= 0) {
			logger.info(`Reading resource: ${uri}`);
		}

		if (!uri.startsWith('mssql://')) {
			throw new Error(`Invalid URI scheme: ${uri}`);
		}

		const uriPath = uri.substring(8); // Remove 'mssql://' prefix
		const parts = uriPath.split('/');

		let connectionName: string | undefined;
		let tableName: string;
		if (parts.length === 3 && parts[2] === 'data') {
			// mssql://{connection}/{table}/data
			connectionName = parts[0];
			tableName = parts[1];
		} else if (parts.length === 2 && parts[1] === 'data') {
			// legacy mssql://{table}/data → default connection
			tableName = parts[0];
		} else {
			throw new Error(`Invalid URI format: ${uri}. Expected mssql://{table}/data or mssql://{connection}/{table}/data.`);
		}

		if (!tableName) {
			throw new Error(`Invalid URI format: ${uri}`);
		}

		const pool = registry.get(connectionName); // throws a clear error on unknown connection

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

	clearCaches(connectionName?: string): number {
		if (!connectionName) {
			const n = resourceCaches.size;
			resourceCaches.clear();
			return n;
		}
		return resourceCaches.delete(connectionName) ? 1 : 0;
	},
};
