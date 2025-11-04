import consola from 'consola';
import sql from 'mssql';
import { getFileLogger } from '../utils/fileLogger';
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
	const fileLogger = getFileLogger();
	fileLogger.info('createConnectionPool() called', {
		server: config.server,
		database: config.database,
		port: config.port,
		windowsAuth: config.windowsAuth,
		encrypt: config.encrypt,
	});

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
		if (consola.level >= 0) {
			logger.info('Configured for Windows Authentication');
		}
		fileLogger.info('Configured for Windows Authentication');
	} else {
		// SQL Server Authentication - use username and password
		if (!config.user || !config.password) {
			fileLogger.error('Username and password are required for SQL authentication');
			throw new Error('Username and password are required for SQL authentication');
		}
		mssqlConfig.user = config.user;
		mssqlConfig.password = config.password;
		if (consola.level >= 0) {
			logger.info(`Configured for SQL Authentication as user: ${config.user}`);
		}
		fileLogger.info(`Configured for SQL Authentication as user: ${config.user}`);
	}

	const pool = new sql.ConnectionPool(mssqlConfig);

	// This MCP server is READ-ONLY by design
	if (consola.level >= 0) {
		logger.info('Connection configured for READ-ONLY access mode (write operations are disabled)');
	}
	fileLogger.info('Connection configured for READ-ONLY mode');

	// PERFORMANCE: Eagerly connect to avoid cold start on first query
	fileLogger.info('Attempting to connect to database...');
	try {
		await pool.connect();
		logger.debug('Connection pool connected eagerly (READ-ONLY mode)');
		fileLogger.info('Connection pool connected successfully (READ-ONLY mode)');
	} catch (error) {
		// CROSS-PLATFORM: Enhanced error messages for common connection issues
		const errorMessage = error instanceof Error ? error.message : String(error);
		const errorStack = error instanceof Error ? error.stack : undefined;
		const isWindows = process.platform === 'win32';

		fileLogger.error('Database connection failed', {
			errorMessage,
			errorStack,
			platform: process.platform,
			config: {
				server: config.server,
				database: config.database,
				port: config.port,
				windowsAuth: config.windowsAuth,
				encrypt: config.encrypt,
			},
		});

		// Windows-specific error handling
		if (isWindows) {
			if (errorMessage.includes('Login failed')) {
				const enhancedError = config.windowsAuth
					? `Windows Authentication failed. Ensure your Windows user account has SQL Server access permissions. Original error: ${errorMessage}`
					: `SQL Authentication failed. Check your username and password. Original error: ${errorMessage}`;
				fileLogger.error(enhancedError);
				throw new Error(enhancedError);
			}

			if (errorMessage.toLowerCase().includes('localdb') || config.server.toLowerCase().includes('localdb')) {
				const enhancedError = `LocalDB connection failed. Verify LocalDB is installed and started. Run 'sqllocaldb info' to check. Original error: ${errorMessage}`;
				fileLogger.error(enhancedError);
				throw new Error(enhancedError);
			}

			if (errorMessage.includes('certificate') || errorMessage.includes('SSL') || errorMessage.includes('TLS')) {
				const enhancedError = `Certificate validation failed. For testing, try setting MSSQL_ENCRYPT=false (not for production). For Azure SQL, ensure proper certificate chain. Original error: ${errorMessage}`;
				fileLogger.error(enhancedError);
				throw new Error(enhancedError);
			}

			if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ETIMEDOUT')) {
				const enhancedError = `Cannot connect to SQL Server at ${config.server}:${config.port}. Verify SQL Server is running and accessible. Check Windows Firewall settings. Original error: ${errorMessage}`;
				fileLogger.error(enhancedError);
				throw new Error(enhancedError);
			}
		}

		// Generic error for non-Windows or unmatched cases
		const genericError = `Failed to connect to SQL Server: ${errorMessage}`;
		fileLogger.error(genericError);
		throw new Error(genericError);
	}

	return {
		async query<T = any>(sqlQuery: string): Promise<T[]> {
			// PERFORMANCE: No need to check isConnected anymore, already connected
			fileLogger.debug('Executing query', { query: sqlQuery.substring(0, 200) });
			try {
				const result = await pool.request().query(sqlQuery);
				if (consola.level >= 0) {
					logger.debug('Read-only query executed successfully');
				}
				fileLogger.debug('Query executed successfully', {
					rowCount: result.recordset?.length || 0,
				});
				return result.recordset as T[];
			} catch (error) {
				if (consola.level >= 0) {
					logger.error('Query execution failed:', error);
				}

				// Get error message for analysis
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				const lower = errorMessage.toLowerCase();

				fileLogger.error('Query execution failed', {
					errorMessage,
					query: sqlQuery.substring(0, 200),
				});

				// FIRST: Check if this is a schema/syntax error (not a write operation)
				// These errors can contain keywords like "create" in column names (e.g., "CreateTime")
				// and should NOT be treated as write operation violations
				if (
					lower.includes('invalid column name')
					|| lower.includes('invalid object name')
					|| lower.includes('incorrect syntax near')
					|| lower.includes('could not find stored procedure')
					|| lower.includes('must declare')
				) {
					// This is a schema/syntax error, not a write operation - throw as-is
					throw error;
				}

				// SECOND: Check if this looks like a write operation that was blocked
				if (
					lower.includes('insert')
					|| lower.includes('update')
					|| lower.includes('delete')
					|| lower.includes('create')
					|| lower.includes('drop')
					|| lower.includes('alter')
				) {
					// This suggests a write operation was attempted
					const writeError = `READ-ONLY mode violation: Write operation detected and blocked. ${errorMessage}`;
					fileLogger.error(writeError);
					throw new Error(writeError);
				}

				// Other errors: throw as-is
				throw error;
			}
		},

		async close(): Promise<void> {
			await pool.close();
			if (consola.level >= 0) {
				logger.info('Connection pool closed');
			}
		},
	};
}
