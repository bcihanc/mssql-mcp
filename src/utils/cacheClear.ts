/**
 * Shared cache-clearing helper for the clear_cache tool.
 * Cache keys are namespaced as `${connectionName}::${rawKey}` (see
 * namespaceCacheKey in utils/identifier.ts), so a connection-filtered clear
 * is a prefix scan.
 */
export function clearMapByPrefix(map: Map<string, unknown>, connectionName?: string): number {
	if (!connectionName) {
		const n = map.size;
		map.clear();
		return n;
	}
	const prefix = `${connectionName}::`;
	let n = 0;
	for (const key of [...map.keys()]) {
		if (key.startsWith(prefix)) {
			map.delete(key);
			n++;
		}
	}
	return n;
}
