/**
 * SQL Server identifier validation and bracketing utilities.
 *
 * Supports cross-database object naming: 1-part (object), 2-part (schema.object),
 * or 3-part (database.schema.object). All parts must contain only alphanumeric
 * characters and underscores; reserved words are protected via bracket-quoting.
 *
 * SECURITY: This is the ONLY safe way to interpolate identifiers into SQL strings.
 * Never bypass this validator — direct string concatenation enables SQL injection.
 */

const FULL_NAME_REGEX = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+){0,2}$/;
// Database names may themselves contain dots (e.g. "Aytemiz.LMS") — safe once
// bracket-quoted, since dots carry no meaning inside [brackets]. Brackets and
// other special characters stay forbidden to prevent injection via early `]`.
const DB_NAME_REGEX = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/;

export interface ObjectNameParts {
	database?: string;
	schema?: string;
	object: string;
}

/**
 * Parse a SQL object name into its database/schema/object parts.
 *
 * Accepted forms:
 *   "users"               → { object: "users" }
 *   "dbo.users"           → { schema: "dbo", object: "users" }
 *   "MyDB.dbo.users"      → { database: "MyDB", schema: "dbo", object: "users" }
 *
 * Empty parts (e.g. "MyDB..users") are rejected — explicit schema is required
 * for 3-part names to prevent silent default-schema bugs in AI-generated calls.
 *
 * @throws Error if any part contains invalid characters or part count is wrong.
 */
export function parseObjectName(name: string): ObjectNameParts {
	if (!name || typeof name !== 'string') {
		throw new Error('Object name must be a non-empty string');
	}

	if (!FULL_NAME_REGEX.test(name)) {
		throw new Error(
			`Invalid object name: "${name}". Allowed: alphanumeric and underscore in each part, separated by dots (1-3 parts).`,
		);
	}

	const parts = name.split('.');
	if (parts.length === 1) {
		return { object: parts[0] };
	}
	if (parts.length === 2) {
		return { schema: parts[0], object: parts[1] };
	}
	return { database: parts[0], schema: parts[1], object: parts[2] };
}

/**
 * Validate and bracket-quote a SQL object name for safe interpolation.
 *
 *   "users"               → "[users]"
 *   "dbo.users"           → "[dbo].[users]"
 *   "MyDB.dbo.users"      → "[MyDB].[dbo].[users]"
 *
 * @throws Error on invalid characters.
 */
export function validateObjectName(name: string): string {
	const parts = parseObjectName(name);
	const out: string[] = [];
	if (parts.database) out.push(`[${parts.database}]`);
	if (parts.schema) out.push(`[${parts.schema}]`);
	out.push(`[${parts.object}]`);
	return out.join('.');
}

/**
 * Validate a single database name (no brackets in input; dots allowed).
 * Returns the bracketed form: "MyDB" → "[MyDB]", "Aytemiz.LMS" → "[Aytemiz.LMS]".
 *
 * Used when a tool accepts an optional `database_name` parameter and needs
 * to construct cross-DB queries like `[MyDB].sys.procedures`.
 */
export function validateDatabaseName(name: string): string {
	if (!name || typeof name !== 'string') {
		throw new Error('Database name must be a non-empty string');
	}
	if (!DB_NAME_REGEX.test(name)) {
		throw new Error(
			`Invalid database name: "${name}". Only alphanumeric characters, underscores and dots are allowed.`,
		);
	}
	return `[${name}]`;
}

/**
 * Build a database-aware cache key prefix for cross-DB tool caches.
 *
 * Cross-DB tools query different databases with the same SQL pattern; without
 * a DB prefix, results would collide in the cache. Use this to namespace cache
 * keys: `${buildCacheKeyPrefix(args.database_name)}${rest_of_key}`.
 *
 * If `dbContext` is undefined, returns "_default_::" (the connection's bound DB).
 */
export function buildCacheKeyPrefix(dbContext?: string): string {
	if (!dbContext) return '_default_::';
	if (!DB_NAME_REGEX.test(dbContext)) {
		throw new Error(`Invalid database context for cache key: "${dbContext}"`);
	}
	return `${dbContext.toLowerCase()}::`;
}

// Connection names are logical labels used as registry keys and cache-key
// prefixes — never interpolated into SQL. Dots are disallowed (unlike DB names)
// because they carry no benefit here and keep the label space clean.
const CONNECTION_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a connection name. Returns the name unchanged if valid.
 * @throws Error if the name contains anything other than letters, digits,
 *   underscore, or hyphen.
 */
export function validateConnectionName(name: string): string {
	if (!name || typeof name !== 'string') {
		throw new Error('Connection name must be a non-empty string');
	}
	if (!CONNECTION_NAME_REGEX.test(name)) {
		throw new Error(
			`Invalid connection name: "${name}". Only letters, digits, underscore and hyphen are allowed.`,
		);
	}
	return name;
}

/**
 * Namespace a cache key by connection name so identical query patterns against
 * different connections never collide in the shared static caches.
 */
export function namespaceCacheKey(connectionName: string, rawKey: string): string {
	return `${connectionName}::${rawKey}`;
}
