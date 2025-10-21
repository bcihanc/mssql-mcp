import consola from 'consola';
import sql from 'mssql';
import type { MssqlConfig as LocalMssqlConfig } from './config';

const logger = consola.withTag('mssql-connection');

export interface ConnectionPool {
	query<T = any>(sqlQuery: string): Promise<T[]>;
	close(): Promise<void>;
}

/**
 * Create a connection pool using the mssql package
 */
export function createConnectionPool(config: LocalMssqlConfig): ConnectionPool {
	const mssqlConfig: sql.config = {
		server: config.server,
		database: config.database,
		port: config.port,
		pool: {
			max: 10,
			min: 0,
			idleTimeoutMillis: 30000,
		},
		options: {
			encrypt: config.encrypt,
			trustServerCertificate: !config.encrypt, // Only trust server cert if not encrypting
		},
	};

	// Configure authentication based on Windows Auth setting
	if (config.windowsAuth) {
		// Windows Authentication - use integrated security
		mssqlConfig.options!.trustedConnection = true;
		logger.info('Configured for Windows Authentication');
	} else {
		// SQL Server Authentication - use username and password
		if (!config.user || !config.password) {
			throw new Error('Username and password are required for SQL authentication');
		}
		mssqlConfig.user = config.user;
		mssqlConfig.password = config.password;
		logger.info(`Configured for SQL Authentication as user: ${config.user}`);
	}

	const pool = new sql.ConnectionPool(mssqlConfig);
	let isConnected = false;

	// This MCP server is READ-ONLY by design
	logger.info('Connection configured for READ-ONLY access mode (write operations are disabled)');

	return {
		async query<T = any>(sqlQuery: string): Promise<T[]> {
			if (!isConnected) {
				await pool.connect();
				isConnected = true;
				logger.debug('Connection pool connected (READ-ONLY mode)');
			}

			try {
				const result = await pool.request().query(sqlQuery);
				logger.debug('Read-only query executed successfully');
				return result.recordset as T[];
			} catch (error) {
				logger.error('Query execution failed:', error);

				// Check if this looks like a write operation that was blocked
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				const lower = errorMessage.toLowerCase();
				if (
					lower.includes('insert')
					|| lower.includes('update')
					|| lower.includes('delete')
					|| lower.includes('create')
					|| lower.includes('drop')
					|| lower.includes('alter')
				) {
					// This suggests a write operation was attempted
					throw new Error(`READ-ONLY mode violation: Write operation detected and blocked. ${errorMessage}`);
				}

				throw error;
			}
		},

		async close(): Promise<void> {
			if (isConnected) {
				await pool.close();
				isConnected = false;
				logger.info('Connection pool closed');
			}
		},
	};
}
