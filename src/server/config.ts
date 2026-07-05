import consola from 'consola';
import { validateConnectionName, validateObjectName } from '../utils/identifier.js';

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
 *
 * @param env Source of environment variables (defaults to `process.env`). Accepting this as a
 *   parameter, rather than reading `process.env` directly, keeps this function deterministic and
 *   lets `parseConnectionConfigs()` thread a synthetic env through the legacy fallback path
 *   without mutating real process state.
 */
export function getMssqlConfig(env: NodeJS.ProcessEnv = process.env): MssqlConfig {
	// Basic configuration
	const server = env.MSSQL_SERVER || 'localhost';
	if (consola.level >= 0) {
		logger.info(`MSSQL_SERVER environment variable: ${env.MSSQL_SERVER || 'NOT SET'}`);
		logger.info(`Using server: ${server}`);
	}

	const rawConfig: MssqlConfig = {
		server,
		user: env.MSSQL_USER,
		password: env.MSSQL_PASSWORD,
		database: env.MSSQL_DATABASE || '',
		port: 1433,
		encrypt: env.MSSQL_ENCRYPT?.toLowerCase() === 'true',
		command: env.MSSQL_COMMAND || 'execute_sql',
		windowsAuth: false,
	};

	// LocalDB conversion and Azure/encrypt normalization are shared with
	// parseConnectionConfigs() via normalizeMssqlConfig() so both paths behave identically.
	const config = normalizeMssqlConfig(rawConfig);

	if (consola.level >= 0 && config.server !== server) {
		logger.info(`Detected LocalDB connection, converted to: ${config.server}`);
	}
	if (consola.level >= 0 && config.encrypt && !rawConfig.encrypt) {
		logger.info('Detected Azure SQL, enabling encryption');
	} else if (consola.level >= 0 && config.encrypt && rawConfig.encrypt) {
		logger.info('Encryption enabled via MSSQL_ENCRYPT setting');
	}

	// Port support (matching Python reference)
	const port = env.MSSQL_PORT;
	if (port) {
		try {
			config.port = parseInt(port, 10);
		} catch (error) {
			if (consola.level >= 0) {
				logger.warn(`Invalid MSSQL_PORT value: ${port}. Using default port 1433.`);
			}
		}
	}

	// Windows Authentication support (matching Python reference behavior)
	const useWindowsAuth = env.MSSQL_WINDOWS_AUTH?.toLowerCase() === 'true';

	if (useWindowsAuth) {
		config.windowsAuth = true;

		// For Windows authentication, user and password are not required
		if (!config.database) {
			if (consola.level >= 0) {
				logger.error('MSSQL_DATABASE is required');
			}
			throw new Error('Missing required database configuration');
		}

		// Remove user and password for Windows auth (matching Python behavior)
		config.user = undefined;
		config.password = undefined;
		if (consola.level >= 0) {
			logger.info('Using Windows Authentication');
		}
	} else {
		// SQL Authentication - user and password are required
		if (!config.user || !config.password || !config.database) {
			if (consola.level >= 0) {
				logger.error('Missing required database configuration. Please check environment variables:');
				logger.error('MSSQL_USER, MSSQL_PASSWORD, and MSSQL_DATABASE are required');
			}
			throw new Error('Missing required database configuration');
		}
	}

	if (consola.level >= 0) {
		if (useWindowsAuth) {
			logger.info(
				`Database config: ${config.server}:${config.port}/${config.database} using Windows Authentication (READ-ONLY mode)`,
			);
		} else {
			logger.info(
				`Database config: ${config.server}:${config.port}/${config.database} as ${config.user} (READ-ONLY mode)`,
			);
		}
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
 * Validate a table name (1-part or 2-part) and return its bracketed form.
 *
 * @deprecated Use `validateObjectName` from `../utils/identifier` instead.
 *   The new validator additionally supports 3-part cross-database names
 *   (`database.schema.table`) and rejects empty parts that the legacy regex
 *   allowed (e.g. `MyDB..users`). This wrapper is retained for backward
 *   compatibility with existing call sites and will be removed in a future
 *   release.
 */
export function validateTableName(tableName: string): string {
	return validateObjectName(tableName);
}

export interface ParsedConnections {
	connections: Map<string, MssqlConfig>;
	defaultName: string;
}

/**
 * Apply LocalDB conversion and Azure/encrypt normalization to a raw config.
 * Shared by getMssqlConfig() and parseConnectionConfigs() so both paths behave
 * identically.
 */
export function normalizeMssqlConfig(raw: MssqlConfig): MssqlConfig {
	let server = raw.server || 'localhost';
	if (server.toLowerCase().includes('(localdb)')) {
		const instanceName = server.replace(/\(localdb\)\\{1,2}/i, '');
		server = `.\\${instanceName}`;
	}
	let encrypt = raw.encrypt;
	if (server.includes('.database.windows.net')) {
		encrypt = true;
	}
	return { ...raw, server, encrypt };
}

interface RawConnectionEntry {
	server?: string;
	database?: string;
	user?: string;
	password?: string;
	port?: number;
	encrypt?: boolean;
	windowsAuth?: boolean;
}

/**
 * Field suffixes recognized in the flat `MSSQL_CONN_<name>_<FIELD>` format,
 * mapped to their `RawConnectionEntry` keys. This flat format is the
 * human-readable alternative to the escaped `MSSQL_CONNECTIONS` JSON blob:
 * every field is its own env var, so a `.mcp.json` "env" block reads one
 * key per line with no `\"` escaping.
 *
 *   MSSQL_CONN_vaay_SERVER   = VAAYDB.local
 *   MSSQL_CONN_vaay_DATABASE = AytemizDB
 *   MSSQL_CONN_vaay_USER     = ReadOnly
 *   MSSQL_CONN_vaay_PASSWORD = ***
 */
const CONN_FIELD_MAP: Record<string, keyof RawConnectionEntry> = {
	SERVER: 'server',
	DATABASE: 'database',
	USER: 'user',
	PASSWORD: 'password',
	PORT: 'port',
	ENCRYPT: 'encrypt',
	WINDOWS_AUTH: 'windowsAuth',
};

// Match the longest field suffix first so the two-token WINDOWS_AUTH is never
// shadowed by an accidental shorter match. Connection names may contain
// underscores and hyphens (see validateConnectionName), so the field is
// identified by matching a known suffix from the RIGHT, and everything before
// it is the connection name.
const CONN_FIELD_SUFFIXES = Object.keys(CONN_FIELD_MAP).sort((a, b) => b.length - a.length);

/**
 * Collect connections defined via flat `MSSQL_CONN_<name>_<FIELD>` env vars.
 *
 * Returns a `{ name → RawConnectionEntry }` record, or `null` when no such vars
 * are present (so the caller can fall through to the legacy single-connection
 * path). Values are coerced to the entry's type (port → number, encrypt /
 * windowsAuth → boolean from the string "true").
 *
 * @throws Error if a `MSSQL_CONN_*` key has no recognized field suffix, or the
 *   embedded connection name is invalid.
 */
function collectPrefixedConnections(env: NodeJS.ProcessEnv): Record<string, RawConnectionEntry> | null {
	const PREFIX = 'MSSQL_CONN_';
	const record: Record<string, RawConnectionEntry> = {};
	let found = false;

	for (const key of Object.keys(env)) {
		if (!key.startsWith(PREFIX)) continue;
		const rest = key.slice(PREFIX.length); // e.g. "vaay_SERVER", "aytemiz-com-tr_WINDOWS_AUTH"

		let matchedSuffix: string | undefined;
		let connName: string | undefined;
		for (const suffix of CONN_FIELD_SUFFIXES) {
			if (rest.endsWith(`_${suffix}`)) {
				matchedSuffix = suffix;
				connName = rest.slice(0, rest.length - suffix.length - 1);
				break;
			}
		}

		if (!matchedSuffix || !connName) {
			throw new Error(
				`Unrecognized connection env var "${key}". Expected MSSQL_CONN_<name>_<FIELD>, where FIELD is one of: ${Object.keys(CONN_FIELD_MAP).join(', ')}.`,
			);
		}

		validateConnectionName(connName); // throws on invalid name

		const value = env[key];
		if (value === undefined) continue;
		found = true;

		const entry = (record[connName] ??= {});
		const field = CONN_FIELD_MAP[matchedSuffix];
		if (field === 'port') {
			const port = parseInt(value, 10);
			if (!Number.isNaN(port)) entry.port = port;
		} else if (field === 'encrypt') {
			entry.encrypt = value.toLowerCase() === 'true';
		} else if (field === 'windowsAuth') {
			entry.windowsAuth = value.toLowerCase() === 'true';
		} else {
			entry[field] = value as never;
		}
	}

	return found ? record : null;
}

/**
 * Validate a `{ name → RawConnectionEntry }` record and turn it into a
 * `Map<string, MssqlConfig>`. Shared by the JSON and flat-env parsing paths so
 * both enforce identical rules (required fields, windowsAuth, normalization).
 *
 * @throws Error on empty record, invalid name, or missing required fields.
 */
function buildConnections(
	rawConnections: Record<string, RawConnectionEntry>,
	env: NodeJS.ProcessEnv,
	sourceLabel: string,
): Map<string, MssqlConfig> {
	const names = Object.keys(rawConnections);
	if (names.length === 0) {
		throw new Error(`${sourceLabel} defines no connections — define at least one.`);
	}

	const connections = new Map<string, MssqlConfig>();
	for (const name of names) {
		validateConnectionName(name); // throws on invalid name
		const entry = rawConnections[name];
		if (!entry || !entry.server || !entry.database) {
			throw new Error(`Connection "${name}" is missing required "server" or "database".`);
		}
		const windowsAuth = entry.windowsAuth === true;
		if (!windowsAuth && (!entry.user || !entry.password)) {
			throw new Error(`Connection "${name}" requires "user" and "password" (or windowsAuth).`);
		}
		const config: MssqlConfig = normalizeMssqlConfig({
			server: entry.server,
			database: entry.database,
			user: windowsAuth ? undefined : entry.user,
			password: windowsAuth ? undefined : entry.password,
			port: entry.port ?? 1433,
			encrypt: entry.encrypt ?? false,
			command: env.MSSQL_COMMAND || 'execute_sql',
			windowsAuth,
		});
		connections.set(name, config);
	}
	return connections;
}

/**
 * Resolve which connection is the default.
 *
 * Precedence: the `MSSQL_DEFAULT_CONNECTION` env override wins over the JSON
 * "default" key (lets projects sharing one config pick their own default via a
 * non-secret env var). Falls back to the JSON default, then — if exactly one
 * connection exists — that sole connection. Otherwise it is a config error.
 *
 * @throws Error if the resolved default names a connection that is not defined,
 *   or multiple connections exist with no default selected.
 */
function resolveDefaultName(
	env: NodeJS.ProcessEnv,
	connections: Map<string, MssqlConfig>,
	jsonDefault: string | undefined,
): string {
	const names = [...connections.keys()];
	const overrideDefault = env.MSSQL_DEFAULT_CONNECTION;
	if (overrideDefault) {
		if (!connections.has(overrideDefault)) {
			throw new Error(
				`MSSQL_DEFAULT_CONNECTION is "${overrideDefault}", which is not a defined connection. Defined: ${names.join(', ')}.`,
			);
		}
		return overrideDefault;
	}
	if (jsonDefault) {
		if (!connections.has(jsonDefault)) {
			throw new Error(
				`"default" points to "${jsonDefault}", which is not a defined connection. Defined: ${names.join(', ')}.`,
			);
		}
		return jsonDefault;
	}
	if (names.length === 1) {
		return names[0];
	}
	throw new Error(
		`Multiple connections defined but no default selected. Set MSSQL_DEFAULT_CONNECTION to one of: ${names.join(', ')}.`,
	);
}

/**
 * Parse multi-connection configuration.
 *
 * Three sources, checked in order:
 * 1. `MSSQL_CONNECTIONS` JSON blob (backward compatible).
 * 2. Flat `MSSQL_CONN_<name>_<FIELD>` env vars (human-readable — one field per
 *    line in `.mcp.json`, no JSON escaping).
 * 3. Legacy single-connection env vars (`MSSQL_SERVER`/...), exposed as a single
 *    connection named "default".
 *
 * @throws Error on malformed JSON, empty connections, invalid names, or an
 *   unresolvable default. Callers surface this as a configuration error.
 */
export function parseConnectionConfigs(env: NodeJS.ProcessEnv = process.env): ParsedConnections {
	const raw = env.MSSQL_CONNECTIONS;

	// Source 1: MSSQL_CONNECTIONS JSON blob
	if (raw) {
		let parsed: { default?: string; connections?: Record<string, RawConnectionEntry> };
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new Error(
				`MSSQL_CONNECTIONS is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`,
			);
		}
		if (!parsed || typeof parsed !== 'object' || !parsed.connections || typeof parsed.connections !== 'object') {
			throw new Error('MSSQL_CONNECTIONS must be an object with a non-empty "connections" map.');
		}
		const connections = buildConnections(parsed.connections, env, 'MSSQL_CONNECTIONS');
		const defaultName = resolveDefaultName(env, connections, parsed.default);
		return { connections, defaultName };
	}

	// Source 2: flat MSSQL_CONN_<name>_<FIELD> env vars
	const prefixed = collectPrefixedConnections(env);
	if (prefixed) {
		const connections = buildConnections(prefixed, env, 'MSSQL_CONN_* variables');
		const defaultName = resolveDefaultName(env, connections, undefined);
		return { connections, defaultName };
	}

	// Source 3: legacy single-connection fallback
	const legacy = getMssqlConfig(env);
	const connections = new Map<string, MssqlConfig>();
	connections.set('default', legacy);
	return { connections, defaultName: 'default' };
}
