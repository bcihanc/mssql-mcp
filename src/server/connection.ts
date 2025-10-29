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
 * PERFORMANCE: Eagerly connects to database to avoid cold start on first query
 */
export async function createConnectionPool(config: LocalMssqlConfig): Promise<ConnectionPool> {
	const mssqlConfig: sql.config = {
		server: config.server,
		database: config.database,
		port: config.port,
		pool: {
			max: 10,
			min: 2, // PERFORMANCE: Keep minimum 2 connections warm to avoid reconnection overhead
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

	// This MCP server is READ-ONLY by design
	logger.info('Connection configured for READ-ONLY access mode (write operations are disabled)');

	// PERFORMANCE: Eagerly connect to avoid cold start on first query
	try {
		await pool.connect();
		logger.debug('Connection pool connected eagerly (READ-ONLY mode)');
	} catch (error) {
		// CROSS-PLATFORM: Enhanced error messages for common connection issues
		const errorMessage = error instanceof Error ? error.message : String(error);
		const isWindows = process.platform === 'win32';

		// Windows-specific error handling
		if (isWindows) {
			if (errorMessage.includes('Login failed')) {
				if (config.windowsAuth) {
					throw new Error(
						`Windows Authentication failed. Ensure your Windows user account has SQL Server access permissions. Original error: ${errorMessage}`,
					);
				} else {
					throw new Error(
						`SQL Authentication failed. Check your username and password. Original error: ${errorMessage}`,
					);
				}
			}

			if (errorMessage.toLowerCase().includes('localdb') || config.server.includes('localdb')) {
				throw new Error(
					`LocalDB connection failed. Verify LocalDB is installed and started. Run 'sqllocaldb info' to check. Original error: ${errorMessage}`,
				);
			}

			if (errorMessage.includes('certificate') || errorMessage.includes('SSL') || errorMessage.includes('TLS')) {
				throw new Error(
					`Certificate validation failed. For testing, try setting MSSQL_ENCRYPT=false (not for production). For Azure SQL, ensure proper certificate chain. Original error: ${errorMessage}`,
				);
			}

			if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ETIMEDOUT')) {
				throw new Error(
					`Cannot connect to SQL Server at ${config.server}:${config.port}. Verify SQL Server is running and accessible. Check Windows Firewall settings. Original error: ${errorMessage}`,
				);
			}
		}

		// Generic error for non-Windows or unmatched cases
		throw new Error(`Failed to connect to SQL Server: ${errorMessage}`);
	}

	return {
		async query<T = any>(sqlQuery: string): Promise<T[]> {
			// PERFORMANCE: No need to check isConnected anymore, already connected
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
			await pool.close();
			logger.info('Connection pool closed');
		},
	};
}
