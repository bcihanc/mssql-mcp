import consola from 'consola';

export interface MssqlConfig {
	server: string;
	database: string;
	user?: string;
	password?: string;
	port: number;
	encrypt: boolean;
	command: string;
	windowsAuth: boolean;
}

const logger = consola.withTag('mssql-config');

/**
 * Get database configuration from environment variables.
 * Matches the exact environment variable structure from the Python reference implementation.
 */
export function getMssqlConfig(): MssqlConfig {
	// Basic configuration
	let server = process.env.MSSQL_SERVER || 'localhost';
	logger.info(`MSSQL_SERVER environment variable: ${process.env.MSSQL_SERVER || 'NOT SET'}`);
	logger.info(`Using server: ${server}`);

	// Handle LocalDB connections (matching Python reference behavior)
	// LocalDB format: (localdb)\instancename
	if (server.startsWith('(localdb)\\')) {
		// For LocalDB, convert to proper format for tedious
		// Convert (localdb)\MSSQLLocalDB to .\\MSSQLLocalDB
		const instanceName = server.replace('(localdb)\\', '');
		server = `.\\${instanceName}`;
		logger.info(`Detected LocalDB connection, converted to: ${server}`);
	}

	const config: MssqlConfig = {
		server,
		user: process.env.MSSQL_USER,
		password: process.env.MSSQL_PASSWORD,
		database: process.env.MSSQL_DATABASE || '',
		port: 1433,
		encrypt: false,
		command: process.env.MSSQL_COMMAND || 'execute_sql',
		windowsAuth: false,
	};

	// Port support (matching Python reference)
	const port = process.env.MSSQL_PORT;
	if (port) {
		try {
			config.port = parseInt(port, 10);
		} catch (error) {
			logger.warn(`Invalid MSSQL_PORT value: ${port}. Using default port 1433.`);
		}
	}

	// Encryption settings for Azure SQL (matching Python reference behavior)
	// Check if we're connecting to Azure SQL
	if (config.server && config.server.includes('.database.windows.net')) {
		config.encrypt = true; // Azure SQL requires encryption
		logger.info('Detected Azure SQL, enabling encryption');
	} else {
		// For non-Azure connections, check MSSQL_ENCRYPT setting
		if (process.env.MSSQL_ENCRYPT?.toLowerCase() === 'true') {
			config.encrypt = true;
			logger.info('Encryption enabled via MSSQL_ENCRYPT setting');
		}
	}

	// Windows Authentication support (matching Python reference behavior)
	const useWindowsAuth = process.env.MSSQL_WINDOWS_AUTH?.toLowerCase() === 'true';

	if (useWindowsAuth) {
		config.windowsAuth = true;

		// For Windows authentication, user and password are not required
		if (!config.database) {
			logger.error('MSSQL_DATABASE is required');
			throw new Error('Missing required database configuration');
		}

		// Remove user and password for Windows auth (matching Python behavior)
		config.user = undefined;
		config.password = undefined;
		logger.info('Using Windows Authentication');
	} else {
		// SQL Authentication - user and password are required
		if (!config.user || !config.password || !config.database) {
			logger.error('Missing required database configuration. Please check environment variables:');
			logger.error('MSSQL_USER, MSSQL_PASSWORD, and MSSQL_DATABASE are required');
			throw new Error('Missing required database configuration');
		}
	}

	if (useWindowsAuth) {
		logger.info(
			`Database config: ${config.server}:${config.port}/${config.database} using Windows Authentication (READ-ONLY mode)`,
		);
	} else {
		logger.info(
			`Database config: ${config.server}:${config.port}/${config.database} as ${config.user} (READ-ONLY mode)`,
		);
	}

	return config;
}

/**
 * Check if a SQL query is a read-only operation with enhanced security validation
 * SECURITY: Protects against Unicode normalization, URL encoding, and hex encoding bypasses
 * PERFORMANCE: Uses combined regex patterns instead of multiple individual tests
 */
export function isReadOnlyQuery(query: string): boolean {
	// SECURITY: Decode common encoding bypasses before validation
	let decodedQuery = query;

	// Decode URL encoding (%XX format) - common bypass technique
	try {
		decodedQuery = decodeURIComponent(decodedQuery);
	} catch {
		// If decoding fails, use original (might be already decoded or invalid)
	}

	// SECURITY: Unicode normalization to prevent homograph attacks
	// Converts lookalike Unicode characters to their canonical forms
	// Example: \u0053 (LATIN CAPITAL LETTER S) → S
	decodedQuery = decodedQuery.normalize('NFKC');

	// Remove SQL comments (line and block) and whitespace
	const cleanQuery = decodedQuery
		.replace(/--.*$/gm, '') // Remove line comments
		.replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
		.replace(/\\/g, '') // Remove backslashes (used in hex encoding bypasses)
		.trim()
		.toUpperCase();

	// If no content left after removing comments, treat as unsafe
	if (!cleanQuery) {
		if (consola.level >= 0) {
			logger.warn('Empty query after sanitization');
		}
		return false;
	}

	// SECURITY: Enhanced dangerous pattern detection with additional bypass protections
	// Matches: DDL, DML, DCL, system commands, multi-statement attacks, and obfuscation attempts
	const dangerousPattern =
		/\b(DROP|TRUNCATE|ALTER|CREATE|INSERT|UPDATE|DELETE|MERGE|GRANT|REVOKE|DENY|EXEC|EXECUTE|SP_EXECUTESQL|XP_CMDSHELL|OPENROWSET|OPENQUERY|OPENDATASOURCE|BULK|INTO|BACKUP|RESTORE|UNION)\b|;\s*(DROP|TRUNCATE|ALTER|INSERT|UPDATE|DELETE|CREATE|EXEC)|0X[0-9A-F]+/i;

	if (dangerousPattern.test(cleanQuery)) {
		if (consola.level >= 0) {
			logger.warn('Dangerous pattern detected in query');
		}
		return false;
	}

	// SECURITY: Check for hex-encoded keywords (e.g., 0x44524F50 = "DROP")
	// This catches attempts to bypass keyword filters using hexadecimal encoding
	if (/0X[0-9A-F]{8,}/i.test(cleanQuery)) {
		if (consola.level >= 0) {
			logger.warn('Hex-encoded content detected - potential bypass attempt');
		}
		return false;
	}

	// PERFORMANCE: Combined regex for whitelist check (single test instead of array iteration)
	// Only allow queries starting with: SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, DESC
	const readOnlyPattern = /^(SELECT|WITH|SHOW|DESCRIBE|EXPLAIN|DESC)\b/;

	if (!readOnlyPattern.test(cleanQuery)) {
		if (consola.level >= 0) {
			logger.warn(`Query does not start with allowed read-only operation: ${cleanQuery.substring(0, 50)}`);
		}
		return false;
	}

	return true;
}

/**
 * Validate table name to prevent SQL injection.
 * Matches the validation logic from the Python reference implementation.
 */
export function validateTableName(tableName: string): string {
	// Allow only alphanumeric, underscore, and dot (for schema.table)
	if (!/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)?$/.test(tableName)) {
		throw new Error(`Invalid table name: ${tableName}`);
	}

	// Split schema and table if present
	const parts = tableName.split('.');
	if (parts.length === 2) {
		// Escape both schema and table name
		return `[${parts[0]}].[${parts[1]}]`;
	} else {
		// Just table name
		return `[${tableName}]`;
	}
}
