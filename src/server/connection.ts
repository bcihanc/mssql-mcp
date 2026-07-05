import consola from 'consola';
import sql from 'mssql';
import { getFileLogger } from '../utils/fileLogger.js';
import type { MssqlConfig as LocalMssqlConfig } from './config.js';

// Driver-level requestTimeout is pool-wide, so it is only a BACKSTOP set high
// enough that per-call increases (up to 300 s) can work. The EFFECTIVE timeout
// is always enforced by the cancel-timer in ResilientConnectionPool.query().
const DRIVER_TIMEOUT_FLOOR_MS = 300000;
const DEFAULT_EFFECTIVE_TIMEOUT_MS = 30000;

export interface QueryOptions {
	/** Per-call timeout in milliseconds; overrides the connection's configured requestTimeout. */
	timeoutMs?: number;
}

/**
 * A dedicated one-off connection for session-scoped statements (SET SHOWPLAN_XML ON).
 * Never taken from the shared pool — pool poisoning is structurally impossible
 * because the connection is closed after use.
 */
export interface EphemeralConnection {
	batch(sqlText: string): Promise<void>;
	query<T = any>(sqlText: string): Promise<T[]>;
	close(): Promise<void>;
}

const logger = consola.withTag('mssql-connection');

export interface ConnectionPool {
	name: string;
	query<T = any>(sqlQuery: string, options?: QueryOptions): Promise<T[]>;
	createEphemeralConnection?(databaseOverride?: string): Promise<EphemeralConnection>;
	close(): Promise<void>;
}

/**
 * Build mssql config object from local config
 * Extracted for reuse by both createConnectionPool and ResilientConnectionPool
 */
function buildMssqlConfig(config: LocalMssqlConfig): sql.config {
	const fileLogger = getFileLogger();

	const mssqlConfig: sql.config = {
		server: config.server,
		database: config.database,
		port: config.port,
		requestTimeout: Math.max(DRIVER_TIMEOUT_FLOOR_MS, config.requestTimeout ?? 0),
		pool: {
			max: 10,
			min: 2, // PERFORMANCE: Keep minimum 2 connections warm to avoid reconnection overhead
			idleTimeoutMillis: 30000,
		},
		options: {
			encrypt: config.encrypt,
			trustServerCertificate: !config.encrypt,
		},
	};

	if (config.windowsAuth) {
		mssqlConfig.options!.trustedConnection = true;
		if (consola.level >= 0) {
			logger.info('Configured for Windows Authentication');
		}
		fileLogger.info('Configured for Windows Authentication');
	} else {
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

	return mssqlConfig;
}

/**
 * Classify and handle query execution errors
 * Shared between createConnectionPool and ResilientConnectionPool
 */
function handleQueryError(error: unknown, sqlQuery: string): never {
	const fileLogger = getFileLogger();
	if (consola.level >= 0) {
		logger.error('Query execution failed:', error);
	}

	const errorMessage = error instanceof Error ? error.message : 'Unknown error';
	const lower = errorMessage.toLowerCase();

	fileLogger.error('Query execution failed', {
		errorMessage,
		query: sqlQuery.substring(0, 200),
	});

	// FIRST: Check if this is a schema/syntax error (not a write operation)
	// CRITICAL: This check MUST come BEFORE write operation check
	// Reason: Error messages can contain both schema AND write keywords
	if (
		lower.includes('invalid column name')
		|| lower.includes('invalid object name')
		|| lower.includes('incorrect syntax near')
		|| lower.includes('could not find stored procedure')
		|| lower.includes('must declare')
		|| lower.includes('ambiguous column name')
	) {
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
		const writeError = `READ-ONLY mode violation: Write operation detected and blocked. ${errorMessage}`;
		fileLogger.error(writeError);
		throw new Error(writeError);
	}

	throw error;
}

/**
 * Check if an error indicates a broken connection (vs a query-level error)
 */
function isConnectionError(error: unknown): boolean {
	const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
	return (
		msg.includes('econnreset')
		|| msg.includes('econnrefused')
		|| msg.includes('etimedout')
		|| msg.includes('esocket')
		|| msg.includes('connection is closed')
		|| msg.includes('connection lost')
		|| msg.includes('not connected')
		|| msg.includes('network')
		|| msg.includes('socket hang up')
	);
}

/**
 * Enhanced error message for connection failures (cross-platform)
 */
function getEnhancedConnectionError(error: unknown, config: LocalMssqlConfig): string {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const isWindows = process.platform === 'win32';

	if (isWindows) {
		if (errorMessage.includes('Login failed')) {
			return config.windowsAuth
				? `Windows Authentication failed. Ensure your Windows user account has SQL Server access permissions. Original error: ${errorMessage}`
				: `SQL Authentication failed. Check your username and password. Original error: ${errorMessage}`;
		}
		if (errorMessage.toLowerCase().includes('localdb') || config.server.toLowerCase().includes('localdb')) {
			return `LocalDB connection failed. Verify LocalDB is installed and started. Run 'sqllocaldb info' to check. Original error: ${errorMessage}`;
		}
		if (errorMessage.includes('certificate') || errorMessage.includes('SSL') || errorMessage.includes('TLS')) {
			return `Certificate validation failed. For testing, try setting MSSQL_ENCRYPT=false (not for production). For Azure SQL, ensure proper certificate chain. Original error: ${errorMessage}`;
		}
		if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ETIMEDOUT')) {
			return `Cannot connect to SQL Server at ${config.server}:${config.port}. Verify SQL Server is running and accessible. Check Windows Firewall settings. Original error: ${errorMessage}`;
		}
	}

	return `Failed to connect to SQL Server: ${errorMessage}`;
}

/**
 * Resilient connection pool with automatic reconnection
 *
 * - Starts MCP server even if database is unavailable
 * - Background retry with exponential backoff (1s → 2s → 4s → ... → max 60s)
 * - Lazy reconnection on tool calls (shared promise prevents thundering herd)
 * - Mid-session disconnect detection via pool error events
 */
export class ResilientConnectionPool implements ConnectionPool {
	private pool: sql.ConnectionPool | null = null;
	private mssqlConfig: sql.config;
	private localConfig: LocalMssqlConfig;
	private connected = false;
	private connectingPromise: Promise<boolean> | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private retryDelay = 1000;
	private readonly maxRetryDelay = 60000;
	private stopped = false;
	private readonly connectionName: string;

	/** Whether the pool is currently connected to the database */
	get isConnected(): boolean {
		return this.connected;
	}

	/** The logical connection name this pool serves (registry key, cache prefix). */
	get name(): string {
		return this.connectionName;
	}

	constructor(config: LocalMssqlConfig, name: string = 'default') {
		this.connectionName = name;
		this.localConfig = config;
		this.mssqlConfig = buildMssqlConfig(config);

		const fileLogger = getFileLogger();
		if (consola.level >= 0) {
			logger.info('Connection configured for READ-ONLY access mode (write operations are disabled)');
		}
		fileLogger.info('ResilientConnectionPool created (READ-ONLY mode)');
	}

	/**
	 * Attempt to connect to the database.
	 * Uses shared promise pattern to prevent thundering herd —
	 * concurrent callers share the same in-flight connection attempt.
	 */
	async ensureConnected(): Promise<boolean> {
		if (this.connected) return true;
		if (this.stopped) return false;
		if (this.connectingPromise) return this.connectingPromise;

		this.connectingPromise = this.doConnect();
		try {
			const result = await this.connectingPromise;
			// If connection failed, automatically start background retry
			if (!result && !this.stopped) {
				this.scheduleBackgroundRetry();
			}
			return result;
		} finally {
			this.connectingPromise = null;
		}
	}

	private async doConnect(): Promise<boolean> {
		const fileLogger = getFileLogger();
		fileLogger.info('Attempting to connect to database...');

		// Close any existing pool before creating a new one to prevent resource leaks
		if (this.pool) {
			try { await this.pool.close(); } catch { /* ignore cleanup errors */ }
			this.pool = null;
		}

		try {
			// Create a fresh pool instance each time — mssql pools can't reliably
			// reconnect after a failed or closed connection
			const newPool = new sql.ConnectionPool(this.mssqlConfig);

			// Listen for mid-session disconnects
			newPool.on('error', (err) => {
				fileLogger.error('Connection pool error event', {
					error: err instanceof Error ? err.message : String(err),
				});
				this.connected = false;
				if (!this.stopped) {
					this.scheduleBackgroundRetry();
				}
			});

			await newPool.connect();
			this.pool = newPool;
			this.connected = true;
			this.retryDelay = 1000; // Reset backoff on success
			this.clearRetryTimer();

			if (consola.level >= 0) {
				logger.debug('Connection pool connected (READ-ONLY mode)');
			}
			fileLogger.info('Connection pool connected successfully (READ-ONLY mode)');
			return true;
		} catch (error) {
			const enhancedError = getEnhancedConnectionError(error, this.localConfig);
			fileLogger.error('Database connection attempt failed', { error: enhancedError });

			// Clean up the failed pool
			try {
				if (this.pool) await this.pool.close();
			} catch { /* ignore cleanup errors */ }
			this.pool = null;
			this.connected = false;

			return false;
		}
	}

	/**
	 * Schedule background retry with exponential backoff.
	 * Backoff schedule: 1s → 2s → 4s → 8s → 16s → 32s → 60s → 60s → ...
	 */
	private scheduleBackgroundRetry(): void {
		if (this.stopped || this.connected || this.retryTimer) return;

		const fileLogger = getFileLogger();
		fileLogger.info(`Scheduling background reconnection attempt in ${this.retryDelay}ms`);

		this.retryTimer = setTimeout(async () => {
			this.retryTimer = null;
			if (this.stopped || this.connected) return;

			const success = await this.ensureConnected();
			if (!success && !this.stopped) {
				this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
				this.scheduleBackgroundRetry();
			}
		}, this.retryDelay);
	}

	private clearRetryTimer(): void {
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
	}

	async query<T = any>(sqlQuery: string, options?: QueryOptions): Promise<T[]> {
		const fileLogger = getFileLogger();

		// Lazy reconnection: if not connected, try to connect now
		if (!this.connected) {
			const success = await this.ensureConnected();
			if (!success) {
				throw new Error(
					'Database is currently unavailable. The server will automatically reconnect when the database becomes available.',
				);
			}
		}

		// Capture local reference to avoid non-null assertion on a mutable field
		const pool = this.pool;
		if (!pool) {
			throw new Error(
				'Database is currently unavailable. The server will automatically reconnect when the database becomes available.',
			);
		}

		fileLogger.debug('Executing query', { query: sqlQuery.substring(0, 200) });
		const effectiveTimeoutMs = options?.timeoutMs ?? this.localConfig.requestTimeout ?? DEFAULT_EFFECTIVE_TIMEOUT_MS;
		const request = pool.request();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try { request.cancel(); } catch { /* cancel is best-effort */ }
		}, effectiveTimeoutMs);
		try {
			const result = await request.query(sqlQuery);
			if (consola.level >= 0) {
				logger.debug('Read-only query executed successfully');
			}
			fileLogger.debug('Query executed successfully', {
				rowCount: result.recordset?.length || 0,
			});
			return result.recordset as T[];
		} catch (error) {
			// FIRST: our own cancellation — must never be classified as connection loss
			if (timedOut) {
				fileLogger.warn('Query cancelled by effective timeout', { effectiveTimeoutMs });
				throw new Error(
					`Query exceeded the ${Math.round(effectiveTimeoutMs / 1000)}-second timeout and was cancelled. Use timeout_seconds to allow more time (max 300).`,
				);
			}
			// If this is a connection error, mark as disconnected and start retry
			if (isConnectionError(error)) {
				fileLogger.error('Connection lost during query execution, starting background retry');
				this.connected = false;
				if (!this.stopped) {
					this.retryDelay = 1000; // Reset backoff for fresh disconnect
					this.scheduleBackgroundRetry();
				}
				throw new Error(
					'Database connection was lost during query execution. The server will automatically reconnect when the database becomes available.',
				);
			}

			// For non-connection errors, use the shared error classifier
			return handleQueryError(error, sqlQuery);
		} finally {
			clearTimeout(timer);
		}
	}

	async createEphemeralConnection(databaseOverride?: string): Promise<EphemeralConnection> {
		const config: sql.config = {
			...buildMssqlConfig(this.localConfig),
			pool: { max: 1, min: 0, idleTimeoutMillis: 5000 },
		};
		if (databaseOverride) config.database = databaseOverride;
		const conn = new sql.ConnectionPool(config);
		await conn.connect();
		return {
			async batch(sqlText: string): Promise<void> {
				await conn.request().batch(sqlText);
			},
			async query<T = any>(sqlText: string): Promise<T[]> {
				const result = await conn.request().query(sqlText);
				return result.recordset as T[];
			},
			async close(): Promise<void> {
				try { await conn.close(); } catch { /* ignore close errors */ }
			},
		};
	}

	async close(): Promise<void> {
		this.stopped = true;
		this.clearRetryTimer();
		if (this.pool) {
			try {
				await this.pool.close();
			} catch { /* ignore cleanup errors */ }
			this.pool = null;
		}
		this.connected = false;
		if (consola.level >= 0) {
			logger.info('Connection pool closed');
		}
	}
}

/**
 * Create a resilient connection pool that handles connection failures gracefully.
 * The pool will automatically retry connecting in the background with exponential backoff.
 */
export function createResilientConnectionPool(config: LocalMssqlConfig, name: string = 'default'): ResilientConnectionPool {
	const fileLogger = getFileLogger();
	fileLogger.info('createResilientConnectionPool() called', {
		connection: name,
		server: config.server,
		database: config.database,
		port: config.port,
		windowsAuth: config.windowsAuth,
		encrypt: config.encrypt,
	});
	return new ResilientConnectionPool(config, name);
}

/**
 * Create a connection pool using the mssql package
 * PERFORMANCE: Eagerly connects to database to avoid cold start on first query
 * @deprecated Use createResilientConnectionPool for graceful connection handling
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

	const mssqlConfig = buildMssqlConfig(config);
	const pool = new sql.ConnectionPool(mssqlConfig);

	if (consola.level >= 0) {
		logger.info('Connection configured for READ-ONLY access mode (write operations are disabled)');
	}
	fileLogger.info('Connection configured for READ-ONLY mode');

	// PERFORMANCE: Eagerly connect to avoid cold start on first query
	fileLogger.info('Attempting to connect to database...');
	try {
		await pool.connect();
		if (consola.level >= 0) {
			logger.debug('Connection pool connected eagerly (READ-ONLY mode)');
		}
		fileLogger.info('Connection pool connected successfully (READ-ONLY mode)');
	} catch (error) {
		const enhancedError = getEnhancedConnectionError(error, config);
		const errorStack = error instanceof Error ? error.stack : undefined;

		fileLogger.error('Database connection failed', {
			errorMessage: enhancedError,
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

		throw new Error(enhancedError);
	}

	return {
		name: 'default',
		async query<T = any>(sqlQuery: string, _options?: QueryOptions): Promise<T[]> {
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
				return handleQueryError(error, sqlQuery);
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
