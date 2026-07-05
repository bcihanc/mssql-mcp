import type { TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import { z } from 'zod/v4';
import { isReadOnlyQuery } from './server/config.js';
import type { ConnectionPool, EphemeralConnection } from './server/connection.js';
import { validateDatabaseName } from './utils/identifier.js';
import { ConnectionScopeSchema } from './utils/connectionScope.js';

const logger = consola.withTag('mssql-performance-tools');

function plainResponse(text: string): { content: TextContent[] } {
	return { content: [{ type: 'text', text }] };
}

function errorResponse(prefix: string, error: unknown): { content: TextContent[] } {
	const msg = error instanceof Error ? error.message : 'Unknown error';
	return { content: [{ type: 'text', text: `${prefix}: ${msg}` }] };
}

const PLAN_MAX_CHARS = 100000;

const GetQueryPlanInputSchema = z.object({
	query: z.string().min(1).describe('The SELECT query to plan. It is NEVER executed — only compiled.'),
	database_name: z.string().optional().describe("Optional database to plan against (the one-off connection opens directly in it). If omitted, uses the connection's current database."),
});

const TOOL_NAMES = new Set(['get_query_plan']);

export const MssqlPerformanceTools = {
	canHandle(name: string): boolean {
		return TOOL_NAMES.has(name);
	},

	getToolDefinitions(): Tool[] {
		return [
			{
				name: 'get_query_plan',
				description: 'Get the ESTIMATED execution plan (SHOWPLAN XML) for a SELECT query WITHOUT executing it, on a dedicated one-off connection. The query must pass the same read-only validation as exec_sql_csv — blocked keywords (UNION, EXEC, INTO, ...) are rejected here too. Requires SHOWPLAN permission (friendly diagnostic when missing).',
				inputSchema: z.toJSONSchema(GetQueryPlanInputSchema.extend(ConnectionScopeSchema.shape)) as any,
			},
		];
	},

	async handleTool(name: string, args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		switch (name) {
			case 'get_query_plan':
				return this.handleGetQueryPlan(args, pool);
		}
		throw new Error(`Unknown tool: ${name}`);
	},

	async handleGetQueryPlan(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = GetQueryPlanInputSchema.parse(args);

			// SECURITY: same multi-layer validation as exec_sql_csv, BEFORE any connection is opened.
			if (!isReadOnlyQuery(v.query)) {
				return plainResponse('Error: This MCP server is READ-ONLY. Only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, and DESC queries are permitted — this applies to plan requests too, including blocked keywords like UNION and EXEC.');
			}
			if (v.database_name) validateDatabaseName(v.database_name);

			if (typeof pool.createEphemeralConnection !== 'function') {
				return plainResponse('get_query_plan is not supported by this connection pool (requires ephemeral connection support).');
			}

			if (consola.level >= 0) logger.info('Getting estimated query plan via ephemeral connection');
			let conn: EphemeralConnection | null = null;
			try {
				conn = await pool.createEphemeralConnection(v.database_name);
				await conn.batch('SET SHOWPLAN_XML ON');
				const rows = await conn.query(v.query);
				const first = rows && rows[0] ? Object.values(rows[0] as Record<string, unknown>)[0] : null;
				if (!first || typeof first !== 'string') {
					return plainResponse('No plan returned — the server did not produce a showplan for this query.');
				}
				let planXml = first;
				let note = '';
				if (planXml.length > PLAN_MAX_CHARS) {
					note = `\n\nℹ️ Plan truncated at ${PLAN_MAX_CHARS} chars (original ${planXml.length}).`;
					planXml = `${planXml.slice(0, PLAN_MAX_CHARS)}...[truncated]`;
				}
				return plainResponse(`Estimated execution plan (query was NOT executed):\n${planXml}${note}`);
			} catch (e) {
				const msg = e instanceof Error ? e.message.toLowerCase() : '';
				if (msg.includes('showplan')) {
					return plainResponse(`🔒 get_query_plan requires the SHOWPLAN permission, which this connection's user lacks. Ask a DBA to run: GRANT SHOWPLAN TO [your_login];`);
				}
				throw e;
			} finally {
				if (conn) await conn.close();
			}
		} catch (error) {
			if (consola.level >= 0) logger.error('get_query_plan error:', error);
			return errorResponse('Error getting query plan', error);
		}
	},

	// get_query_plan is never cached, so this layer holds no cache entries.
	clearCaches(_connectionName?: string): number {
		return 0;
	},
};
