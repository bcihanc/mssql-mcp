import { validateConnectionName } from '../utils/identifier.js';
import type { MssqlConfig } from './config.js';
import type { ParsedConnections } from './config.js';
import { createResilientConnectionPool, ResilientConnectionPool } from './connection.js';

export interface ConnectionInfo {
	name: string;
	server: string;
	database: string;
	user: string;
	is_default: boolean;
}

/**
 * Holds one ResilientConnectionPool per named connection. Pools are created but
 * NOT connected here — each connects lazily on its first query (VPN-friendly:
 * an unreachable connection never spins background retries until it is used).
 */
export class ConnectionRegistry {
	private readonly pools = new Map<string, ResilientConnectionPool>();
	private readonly configs = new Map<string, MssqlConfig>();
	readonly defaultName: string;

	constructor(parsed: ParsedConnections) {
		this.defaultName = parsed.defaultName;
		for (const [name, config] of parsed.connections) {
			this.configs.set(name, config);
			this.pools.set(name, createResilientConnectionPool(config, name));
		}
	}

	/** Resolve a pool by name; falls back to the default connection when name is omitted. */
	get(name?: string): ResilientConnectionPool {
		const target = name ?? this.defaultName;
		const pool = this.pools.get(target);
		if (!pool) {
			throw new Error(
				`Unknown connection: "${target}". Defined connections: ${[...this.pools.keys()].join(', ')}.`,
			);
		}
		return pool;
	}

	has(name: string): boolean {
		return this.pools.has(name);
	}

	/** Public connection metadata for list_connections. NEVER includes passwords. */
	list(): ConnectionInfo[] {
		const out: ConnectionInfo[] = [];
		for (const [name, config] of this.configs) {
			out.push({
				name,
				server: config.server,
				database: config.database,
				user: config.user ?? (config.windowsAuth ? '(Windows Auth)' : ''),
				is_default: name === this.defaultName,
			});
		}
		return out;
	}

	async closeAll(): Promise<void> {
		for (const pool of this.pools.values()) {
			try {
				await pool.close();
			} catch {
				/* ignore individual close errors */
			}
		}
	}
}

/**
 * Resolve the target pool for a tool call from its args. Extracts and validates
 * `connection_name`; omitted -> default connection.
 * @throws Error on invalid name format or unknown connection.
 */
export function resolvePoolForCall(registry: ConnectionRegistry, args: any): ResilientConnectionPool {
	const raw = args?.connection_name;
	if (raw === undefined || raw === null) {
		return registry.get();
	}
	const name = validateConnectionName(String(raw)); // throws on bad format
	return registry.get(name); // throws on unknown
}
