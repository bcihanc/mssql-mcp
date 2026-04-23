import type { TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import { z } from 'zod/v4';
import type { ConnectionPool } from './server/connection.js';
import { formatCSV } from './utils/csv.js';
import { buildCacheKeyPrefix, validateDatabaseName } from './utils/identifier.js';

const logger = consola.withTag('mssql-diagnostics-tools');

interface ToolCacheEntry {
	result: string;
	timestamp: number;
	lastAccessed: number;
}

const JOBS_CACHE_TTL_MS = parseInt(process.env.MSSQL_JOBS_CACHE_TTL || '1800000', 10);
const JOB_HISTORY_CACHE_TTL_MS = parseInt(process.env.MSSQL_JOB_HISTORY_CACHE_TTL || '300000', 10);

const jobsCache = new Map<string, ToolCacheEntry>();
const jobHistoryCache = new Map<string, ToolCacheEntry>();

function cleanExpired(cache: Map<string, ToolCacheEntry>, key: string, ttlMs: number): boolean {
	const entry = cache.get(key);
	if (entry && Date.now() - entry.timestamp > ttlMs) {
		cache.delete(key);
		return true;
	}
	return false;
}

function enforceSizeLimit(cache: Map<string, ToolCacheEntry>, maxSize: number, name: string): void {
	if (cache.size > maxSize) {
		const entries = Array.from(cache.entries()).sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
		const toDelete = cache.size - maxSize;
		for (let i = 0; i < toDelete; i++) cache.delete(entries[i][0]);
		if (consola.level >= 0) logger.debug(`${name} LRU eviction: removed ${toDelete} entries`);
	}
}

function getFromCache(cache: Map<string, ToolCacheEntry>, key: string, ttlMs: number): string | null {
	if (!cleanExpired(cache, key, ttlMs)) {
		const entry = cache.get(key);
		if (entry) {
			entry.lastAccessed = Date.now();
			return entry.result;
		}
	}
	return null;
}

function setInCache(cache: Map<string, ToolCacheEntry>, key: string, result: string, maxSize: number, name: string): void {
	const now = Date.now();
	cache.set(key, { result, timestamp: now, lastAccessed: now });
	enforceSizeLimit(cache, maxSize, name);
}

function escapeLiteral(s: string): string {
	return s.replace(/'/g, "''");
}

function plainResponse(text: string): { content: TextContent[] } {
	return { content: [{ type: 'text', text }] };
}

function cachedResponse(text: string): { content: TextContent[] } {
	return { content: [{ type: 'text', text: `${text}\n\n📋 (Cached result)` }] };
}

function errorResponse(prefix: string, error: unknown): { content: TextContent[] } {
	const msg = error instanceof Error ? error.message : 'Unknown error';
	return { content: [{ type: 'text', text: `${prefix}: ${msg}` }] };
}

function isPermissionError(error: unknown): boolean {
	const msg = error instanceof Error ? error.message.toLowerCase() : '';
	return msg.includes('permission') || msg.includes('denied') || msg.includes('not have permission');
}

function permissionDeniedResponse(toolHumanName: string, requiredPerm: string): { content: TextContent[] } {
	return plainResponse(
		`🔒 ${toolHumanName} — permission denied. This tool requires: ${requiredPerm}\n` +
		`Run as a sysadmin: GRANT ${requiredPerm} TO [your_user]`,
	);
}

const ListJobsInputSchema = z.object({
	enabled_only: z.boolean().optional().describe('Show only enabled jobs (default: false, shows all)'),
});

const JobIdentifierSchema = z.object({
	job_name: z.string().min(1).describe('Name of the SQL Agent job (case-insensitive match)'),
});

const JobHistoryInputSchema = JobIdentifierSchema.extend({
	limit: z.number().int().positive().optional().describe('Maximum number of recent runs to return (default: 20, max: 200)'),
});

const IndexUsageInputSchema = z.object({
	database_name: z.string().optional().describe('Optional cross-database scope. Default: current database.'),
	min_seeks_scans: z.number().int().nonnegative().optional().describe('Minimum total seeks+scans+lookups to include (default: 0 — show all). Use to filter for "actively used" indexes.'),
});

const MissingIndexesInputSchema = z.object({
	database_name: z.string().optional().describe('Optional cross-database scope.'),
	top: z.number().int().positive().optional().describe('Top N missing indexes by impact score (default: 20, max: 100)'),
});

const TopQueriesInputSchema = z.object({
	top: z.number().int().positive().optional().describe('Top N queries (default: 20, max: 100)'),
	order_by: z.enum(['total_elapsed_time', 'total_logical_reads', 'total_worker_time', 'execution_count']).optional().describe('Sort by which metric (default: total_elapsed_time)'),
});

const ActiveSessionsInputSchema = z.object({
	include_system: z.boolean().optional().describe('Include system processes (default: false). Note: without VIEW SERVER STATE permission, only the current connection\'s own session is visible.'),
});

const NoArgsSchema = z.object({});

const WaitStatsInputSchema = z.object({
	top: z.number().int().positive().optional().describe('Top N wait types by total wait time (default: 20, max: 100)'),
});

const TOOL_NAMES = new Set([
	'list_sql_agent_jobs',
	'get_job_steps',
	'get_job_history',
	'list_job_schedules',
	'get_index_usage_stats',
	'get_missing_indexes',
	'get_top_expensive_queries',
	'get_active_sessions',
	'get_blocking_sessions',
	'get_wait_stats',
]);

const HARD_CAP_TOP = 100;

function clampTop(n: number | undefined, def: number): number {
	let v = n ?? def;
	if (!Number.isFinite(v) || v < 1) v = def;
	if (v > HARD_CAP_TOP) v = HARD_CAP_TOP;
	return Math.floor(v);
}

export const MssqlDiagnosticsTools = {
	canHandle(name: string): boolean {
		return TOOL_NAMES.has(name);
	},

	getToolDefinitions(): Tool[] {
		return [
			{
				name: 'list_sql_agent_jobs',
				description: 'List all SQL Agent jobs from msdb.dbo.sysjobs with id, name, enabled flag, description, owner login, and create/modify dates. Requires SELECT permission on msdb.dbo.sysjobs (typically a SQLAgentReaderRole/SQLAgentUserRole/SQLAgentOperatorRole member).',
				inputSchema: z.toJSONSchema(ListJobsInputSchema) as any,
			},
			{
				name: 'get_job_steps',
				description: 'Get the steps for a SQL Agent job (msdb.dbo.sysjobsteps): step number, name, subsystem (TSQL/SSIS/CmdExec/PowerShell/etc), database context, command body, and on-success/on-failure actions.',
				inputSchema: z.toJSONSchema(JobIdentifierSchema) as any,
			},
			{
				name: 'get_job_history',
				description: 'Get recent execution history of a SQL Agent job (msdb.dbo.sysjobhistory): step name, run datetime, duration (HHMMSS), run status (Failed/Succeeded/Retry/Canceled/InProgress), and message. Default: last 20 runs (sorted newest first), max 200.',
				inputSchema: z.toJSONSchema(JobHistoryInputSchema) as any,
			},
			{
				name: 'list_job_schedules',
				description: 'List all SQL Agent schedules and their job assignments (msdb.dbo.sysschedules + sysjobschedules). Returns schedule name, frequency type/interval, active start/end times, and which jobs use the schedule.',
				inputSchema: z.toJSONSchema(NoArgsSchema) as any,
			},
			{
				name: 'get_index_usage_stats',
				description: 'List index usage from sys.dm_db_index_usage_stats — seeks, scans, lookups, updates, and last access times. Useful for identifying unused or write-heavy indexes that may be removal candidates. Requires VIEW DATABASE STATE permission. Stats reset on SQL Server restart.',
				inputSchema: z.toJSONSchema(IndexUsageInputSchema) as any,
			},
			{
				name: 'get_missing_indexes',
				description: 'List indexes that the SQL Server query optimizer believes would help recent queries (sys.dm_db_missing_index_details + impact stats). Returns table, equality/inequality/included columns, expected impact percentage, and seeks/scans saved. Requires VIEW SERVER STATE.',
				inputSchema: z.toJSONSchema(MissingIndexesInputSchema) as any,
			},
			{
				name: 'get_top_expensive_queries',
				description: 'List the most expensive queries from sys.dm_exec_query_stats by execution_count, total_elapsed_time (default), total_logical_reads, or total_worker_time. Returns the SQL statement text, plan handle, and aggregate stats. Requires VIEW SERVER STATE.',
				inputSchema: z.toJSONSchema(TopQueriesInputSchema) as any,
			},
			{
				name: 'get_active_sessions',
				description: 'List active sessions (sys.dm_exec_sessions joined with sys.dm_exec_requests when running). Returns session id, login, host, program, status, current SQL text, and CPU/IO/wait stats. **Without VIEW SERVER STATE, only the calling connection\'s own session is visible** (SQL Server hides others by default).',
				inputSchema: z.toJSONSchema(ActiveSessionsInputSchema) as any,
			},
			{
				name: 'get_blocking_sessions',
				description: 'List currently blocked sessions (sys.dm_exec_requests WHERE blocking_session_id != 0) along with the blocker. Returns blocker→victim chains, the resource being waited on, and current SQL of both. Requires VIEW SERVER STATE.',
				inputSchema: z.toJSONSchema(NoArgsSchema) as any,
			},
			{
				name: 'get_wait_stats',
				description: 'List the top N wait types by total wait time from sys.dm_os_wait_stats. Useful for identifying server-wide bottlenecks (CPU, IO, locking, parallelism, etc.). Filters out benign idle waits (CHECKPOINT_QUEUE, BROKER_*, LAZYWRITER_SLEEP, etc.). Requires VIEW SERVER STATE.',
				inputSchema: z.toJSONSchema(WaitStatsInputSchema) as any,
			},
		];
	},

	async handleTool(name: string, args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		switch (name) {
			case 'list_sql_agent_jobs':
				return this.handleListJobs(args, pool);
			case 'get_job_steps':
				return this.handleGetJobSteps(args, pool);
			case 'get_job_history':
				return this.handleGetJobHistory(args, pool);
			case 'list_job_schedules':
				return this.handleListJobSchedules(pool);
			case 'get_index_usage_stats':
				return this.handleIndexUsageStats(args, pool);
			case 'get_missing_indexes':
				return this.handleMissingIndexes(args, pool);
			case 'get_top_expensive_queries':
				return this.handleTopExpensiveQueries(args, pool);
			case 'get_active_sessions':
				return this.handleActiveSessions(args, pool);
			case 'get_blocking_sessions':
				return this.handleBlockingSessions(pool);
			case 'get_wait_stats':
				return this.handleWaitStats(args, pool);
		}
		throw new Error(`Unknown tool: ${name}`);
	},

	async handleListJobs(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = ListJobsInputSchema.parse(args);
			const cacheKey = v.enabled_only ? 'enabled' : 'all';
			const cached = getFromCache(jobsCache, cacheKey, JOBS_CACHE_TTL_MS);
			if (cached !== null) return cachedResponse(cached);

			const where = v.enabled_only ? `WHERE j.enabled = 1` : '';
			const query = `SELECT j.job_id, j.name, j.enabled, j.description, j.date_created, j.date_modified, SUSER_SNAME(j.owner_sid) AS owner_login FROM msdb.dbo.sysjobs j ${where} ORDER BY j.name`;

			if (consola.level >= 0) logger.info(`Listing SQL Agent jobs (enabled_only=${!!v.enabled_only})`);
			let results;
			try {
				results = await pool.query(query);
			} catch (e) {
				if (isPermissionError(e)) return permissionDeniedResponse('list_sql_agent_jobs', 'SELECT ON msdb.dbo.sysjobs (or membership in SQLAgentReaderRole)');
				throw e;
			}

			if (!results || results.length === 0) return plainResponse('No SQL Agent jobs found.');
			const csv = formatCSV(results);
			setInCache(jobsCache, cacheKey, csv, 4, 'list_sql_agent_jobs');
			return plainResponse(csv);
		} catch (error) {
			if (consola.level >= 0) logger.error('list_sql_agent_jobs error:', error);
			return errorResponse('Error listing SQL Agent jobs', error);
		}
	},

	async handleGetJobSteps(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = JobIdentifierSchema.parse(args);
			const query = `SELECT s.step_id, s.step_name, s.subsystem, s.database_name, s.command, s.on_success_action, s.on_fail_action, s.last_run_outcome, s.last_run_date, s.last_run_time, s.last_run_duration FROM msdb.dbo.sysjobsteps s INNER JOIN msdb.dbo.sysjobs j ON s.job_id = j.job_id WHERE j.name = '${escapeLiteral(v.job_name)}' ORDER BY s.step_id`;

			if (consola.level >= 0) logger.info(`Fetching steps for job: ${v.job_name}`);
			let results;
			try {
				results = await pool.query(query);
			} catch (e) {
				if (isPermissionError(e)) return permissionDeniedResponse('get_job_steps', 'SELECT ON msdb.dbo.sysjobsteps + sysjobs');
				throw e;
			}

			if (!results || results.length === 0) return plainResponse(`No steps found for job '${v.job_name}'. (Job may not exist.)`);
			return plainResponse(formatCSV(results));
		} catch (error) {
			if (consola.level >= 0) logger.error('get_job_steps error:', error);
			return errorResponse('Error fetching job steps', error);
		}
	},

	async handleGetJobHistory(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = JobHistoryInputSchema.parse(args);
			let limit = v.limit ?? 20;
			if (limit > 200) limit = 200;
			if (limit < 1) limit = 1;
			const cacheKey = `${v.job_name.toLowerCase()}:${limit}`;
			const cached = getFromCache(jobHistoryCache, cacheKey, JOB_HISTORY_CACHE_TTL_MS);
			if (cached !== null) return cachedResponse(cached);

			const query = `SELECT TOP ${limit} h.step_id, h.step_name, msdb.dbo.agent_datetime(h.run_date, h.run_time) AS run_datetime, h.run_duration, CASE h.run_status WHEN 0 THEN 'Failed' WHEN 1 THEN 'Succeeded' WHEN 2 THEN 'Retry' WHEN 3 THEN 'Canceled' WHEN 4 THEN 'In Progress' ELSE 'Unknown' END AS run_status, h.message FROM msdb.dbo.sysjobhistory h INNER JOIN msdb.dbo.sysjobs j ON h.job_id = j.job_id WHERE j.name = '${escapeLiteral(v.job_name)}' ORDER BY h.run_date DESC, h.run_time DESC, h.instance_id DESC`;

			if (consola.level >= 0) logger.info(`Fetching history for job: ${v.job_name} (limit=${limit})`);
			let results;
			try {
				results = await pool.query(query);
			} catch (e) {
				if (isPermissionError(e)) return permissionDeniedResponse('get_job_history', 'SELECT ON msdb.dbo.sysjobhistory + sysjobs');
				throw e;
			}

			if (!results || results.length === 0) return plainResponse(`No history found for job '${v.job_name}'.`);
			const csv = formatCSV(results);
			setInCache(jobHistoryCache, cacheKey, csv, 50, 'get_job_history');
			return plainResponse(csv);
		} catch (error) {
			if (consola.level >= 0) logger.error('get_job_history error:', error);
			return errorResponse('Error fetching job history', error);
		}
	},

	async handleListJobSchedules(pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const query = `SELECT sch.schedule_id, sch.name AS schedule_name, sch.enabled, sch.freq_type, sch.freq_interval, sch.freq_subday_type, sch.freq_subday_interval, sch.active_start_time, sch.active_end_time, j.name AS job_name FROM msdb.dbo.sysschedules sch LEFT JOIN msdb.dbo.sysjobschedules js ON sch.schedule_id = js.schedule_id LEFT JOIN msdb.dbo.sysjobs j ON js.job_id = j.job_id ORDER BY sch.name, j.name`;

			if (consola.level >= 0) logger.info('Listing SQL Agent schedules');
			let results;
			try {
				results = await pool.query(query);
			} catch (e) {
				if (isPermissionError(e)) return permissionDeniedResponse('list_job_schedules', 'SELECT ON msdb.dbo.sysschedules + sysjobschedules + sysjobs');
				throw e;
			}

			if (!results || results.length === 0) return plainResponse('No SQL Agent schedules configured.');
			return plainResponse(formatCSV(results));
		} catch (error) {
			if (consola.level >= 0) logger.error('list_job_schedules error:', error);
			return errorResponse('Error listing job schedules', error);
		}
	},

	async handleIndexUsageStats(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = IndexUsageInputSchema.parse(args);
			let dbPrefix = '';
			let dbIdExpr = 'DB_ID()';
			if (v.database_name) {
				const bracketed = validateDatabaseName(v.database_name);
				dbPrefix = `${bracketed}.`;
				dbIdExpr = `DB_ID('${escapeLiteral(v.database_name)}')`;
			}
			const minActivity = v.min_seeks_scans ?? 0;

			const query = `SELECT OBJECT_SCHEMA_NAME(s.object_id, ${dbIdExpr}) AS table_schema, OBJECT_NAME(s.object_id, ${dbIdExpr}) AS table_name, i.name AS index_name, i.type_desc AS index_type, s.user_seeks, s.user_scans, s.user_lookups, s.user_updates, s.last_user_seek, s.last_user_scan, s.last_user_lookup FROM ${dbPrefix}sys.dm_db_index_usage_stats s INNER JOIN ${dbPrefix}sys.indexes i ON s.object_id = i.object_id AND s.index_id = i.index_id WHERE s.database_id = ${dbIdExpr} AND OBJECTPROPERTY(s.object_id, 'IsUserTable') = 1 AND (s.user_seeks + s.user_scans + s.user_lookups) >= ${minActivity} ORDER BY (s.user_seeks + s.user_scans + s.user_lookups) DESC, table_schema, table_name`;

			if (consola.level >= 0) logger.info(`Fetching index usage stats for ${v.database_name || 'current DB'}`);
			let results;
			try {
				results = await pool.query(query);
			} catch (e) {
				if (isPermissionError(e)) return permissionDeniedResponse('get_index_usage_stats', 'VIEW DATABASE STATE');
				throw e;
			}

			if (!results || results.length === 0) return plainResponse('No index usage stats found. (Stats reset on SQL Server restart and are populated as queries run.)');
			return plainResponse(formatCSV(results));
		} catch (error) {
			if (consola.level >= 0) logger.error('get_index_usage_stats error:', error);
			return errorResponse('Error fetching index usage stats', error);
		}
	},

	async handleMissingIndexes(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = MissingIndexesInputSchema.parse(args);
			const top = clampTop(v.top, 20);
			let dbPrefix = '';
			let dbIdFilter = 'mid.database_id = DB_ID()';
			if (v.database_name) {
				const bracketed = validateDatabaseName(v.database_name);
				dbPrefix = `${bracketed}.`;
				dbIdFilter = `mid.database_id = DB_ID('${escapeLiteral(v.database_name)}')`;
			}

			const query = `SELECT TOP ${top} CAST(migs.avg_total_user_cost * migs.avg_user_impact * (migs.user_seeks + migs.user_scans) AS DECIMAL(18,2)) AS impact_score, mid.statement AS table_full_name, mid.equality_columns, mid.inequality_columns, mid.included_columns, migs.user_seeks, migs.user_scans, migs.unique_compiles, CAST(migs.avg_user_impact AS DECIMAL(5,2)) AS avg_user_impact_pct FROM ${dbPrefix}sys.dm_db_missing_index_groups mig INNER JOIN ${dbPrefix}sys.dm_db_missing_index_group_stats migs ON mig.index_group_handle = migs.group_handle INNER JOIN ${dbPrefix}sys.dm_db_missing_index_details mid ON mig.index_handle = mid.index_handle WHERE ${dbIdFilter} ORDER BY impact_score DESC`;

			if (consola.level >= 0) logger.info(`Fetching missing indexes for ${v.database_name || 'current DB'}`);
			let results;
			try {
				results = await pool.query(query);
			} catch (e) {
				if (isPermissionError(e)) return permissionDeniedResponse('get_missing_indexes', 'VIEW SERVER STATE');
				throw e;
			}

			if (!results || results.length === 0) return plainResponse('No missing index suggestions. (SQL Server populates this as queries run; an empty result is normal on a recently restarted instance.)');
			return plainResponse(formatCSV(results));
		} catch (error) {
			if (consola.level >= 0) logger.error('get_missing_indexes error:', error);
			return errorResponse('Error fetching missing indexes', error);
		}
	},

	async handleTopExpensiveQueries(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = TopQueriesInputSchema.parse(args);
			const top = clampTop(v.top, 20);
			const orderBy = v.order_by ?? 'total_elapsed_time';

			const query = `SELECT TOP ${top} qs.execution_count, qs.total_elapsed_time / 1000 AS total_elapsed_ms, qs.total_worker_time / 1000 AS total_cpu_ms, qs.total_logical_reads, qs.total_physical_reads, qs.creation_time, qs.last_execution_time, SUBSTRING(st.text, (qs.statement_start_offset/2)+1, ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text) ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1) AS statement_text FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st ORDER BY qs.${orderBy} DESC`;

			if (consola.level >= 0) logger.info(`Fetching top ${top} expensive queries by ${orderBy}`);
			let results;
			try {
				results = await pool.query(query);
			} catch (e) {
				if (isPermissionError(e)) return permissionDeniedResponse('get_top_expensive_queries', 'VIEW SERVER STATE');
				throw e;
			}

			if (!results || results.length === 0) return plainResponse('No queries in the plan cache. (Cache may have been cleared or the server recently restarted.)');
			return plainResponse(formatCSV(results));
		} catch (error) {
			if (consola.level >= 0) logger.error('get_top_expensive_queries error:', error);
			return errorResponse('Error fetching top queries', error);
		}
	},

	async handleActiveSessions(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = ActiveSessionsInputSchema.parse(args);
			const filters: string[] = [];
			if (!v.include_system) filters.push('s.is_user_process = 1');
			const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

			const query = `SELECT s.session_id, s.login_name, s.host_name, s.program_name, s.status, s.cpu_time, s.memory_usage, s.total_elapsed_time, s.last_request_start_time, s.last_request_end_time, r.command AS current_command, SUBSTRING(st.text, (r.statement_start_offset/2)+1, ((CASE r.statement_end_offset WHEN -1 THEN DATALENGTH(st.text) ELSE r.statement_end_offset END - r.statement_start_offset)/2)+1) AS current_statement FROM sys.dm_exec_sessions s LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st ${where} ORDER BY s.session_id`;

			if (consola.level >= 0) logger.info(`Fetching active sessions (include_system=${!!v.include_system})`);
			let results;
			try {
				results = await pool.query(query);
			} catch (e) {
				if (isPermissionError(e)) return permissionDeniedResponse('get_active_sessions', 'VIEW SERVER STATE (without it, only your own session is visible)');
				throw e;
			}

			if (!results || results.length === 0) return plainResponse('No active sessions. (If you expected more than your own, you may lack VIEW SERVER STATE.)');
			const csv = formatCSV(results);
			const note = results.length === 1 ? '\n\nℹ️ Only 1 session visible — without VIEW SERVER STATE, SQL Server hides other users\' sessions.' : '';
			return plainResponse(csv + note);
		} catch (error) {
			if (consola.level >= 0) logger.error('get_active_sessions error:', error);
			return errorResponse('Error fetching sessions', error);
		}
	},

	async handleBlockingSessions(pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const query = `SELECT r.session_id AS blocked_session_id, r.blocking_session_id, r.wait_type, r.wait_time, r.wait_resource, r.command AS blocked_command, blocked_st.text AS blocked_sql, blocker_s.login_name AS blocker_login, blocker_s.host_name AS blocker_host, blocker_s.program_name AS blocker_program, blocker_st.text AS blocker_last_sql FROM sys.dm_exec_requests r LEFT JOIN sys.dm_exec_sessions blocker_s ON r.blocking_session_id = blocker_s.session_id LEFT JOIN sys.dm_exec_connections blocker_c ON r.blocking_session_id = blocker_c.session_id OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) blocked_st OUTER APPLY sys.dm_exec_sql_text(blocker_c.most_recent_sql_handle) blocker_st WHERE r.blocking_session_id != 0 ORDER BY r.wait_time DESC`;

			if (consola.level >= 0) logger.info('Fetching blocking sessions');
			let results;
			try {
				results = await pool.query(query);
			} catch (e) {
				if (isPermissionError(e)) return permissionDeniedResponse('get_blocking_sessions', 'VIEW SERVER STATE');
				throw e;
			}

			if (!results || results.length === 0) return plainResponse('✅ No blocking detected. All sessions running freely.');
			return plainResponse(formatCSV(results));
		} catch (error) {
			if (consola.level >= 0) logger.error('get_blocking_sessions error:', error);
			return errorResponse('Error fetching blocking sessions', error);
		}
	},

	async handleWaitStats(args: any, pool: ConnectionPool): Promise<{ content: TextContent[] }> {
		try {
			const v = WaitStatsInputSchema.parse(args);
			const top = clampTop(v.top, 20);

			// Standard list of benign waits to filter (Paul Randal's well-known list, abbreviated)
			const benignWaits = [
				'CHECKPOINT_QUEUE', 'BROKER_TASK_STOP', 'BROKER_TO_FLUSH', 'BROKER_TRANSMITTER',
				'BROKER_EVENTHANDLER', 'BROKER_RECEIVE_WAITFOR', 'CLR_AUTO_EVENT', 'CLR_MANUAL_EVENT',
				'DBMIRROR_DBM_EVENT', 'DBMIRROR_EVENTS_QUEUE', 'DBMIRRORING_CMD', 'DIRTY_PAGE_POLL',
				'DISPATCHER_QUEUE_SEMAPHORE', 'EXECSYNC', 'FSAGENT', 'FT_IFTS_SCHEDULER_IDLE_WAIT',
				'FT_IFTSHC_MUTEX', 'HADR_CLUSAPI_CALL', 'HADR_FILESTREAM_IOMGR_IOCOMPLETION',
				'HADR_LOGCAPTURE_WAIT', 'HADR_NOTIFICATION_DEQUEUE', 'HADR_TIMER_TASK',
				'HADR_WORK_QUEUE', 'KSOURCE_WAKEUP', 'LAZYWRITER_SLEEP', 'LOGMGR_QUEUE',
				'MEMORY_ALLOCATION_EXT', 'ONDEMAND_TASK_QUEUE', 'PARALLEL_REDO_WORKER_WAIT_WORK',
				'PREEMPTIVE_HADR_LEASE_MECHANISM', 'PREEMPTIVE_SP_SERVER_DIAGNOSTICS',
				'PREEMPTIVE_OS_LIBRARYOPS', 'QDS_PERSIST_TASK_MAIN_LOOP_SLEEP',
				'QDS_ASYNC_QUEUE', 'QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP',
				'REQUEST_FOR_DEADLOCK_SEARCH', 'SLEEP_TASK', 'SLEEP_SYSTEMTASK',
				'SQLTRACE_BUFFER_FLUSH', 'SQLTRACE_INCREMENTAL_FLUSH_SLEEP', 'SQLTRACE_WAIT_ENTRIES',
				'WAIT_FOR_RESULTS', 'WAITFOR', 'WAITFOR_TASKSHUTDOWN', 'WAIT_XTP_HOST_WAIT',
				'WAIT_XTP_OFFLINE_CKPT_NEW_LOG', 'WAIT_XTP_CKPT_CLOSE', 'XE_DISPATCHER_JOIN',
				'XE_DISPATCHER_WAIT', 'XE_TIMER_EVENT',
			];
			const filterClause = benignWaits.map((w) => `'${w}'`).join(',');

			const query = `SELECT TOP ${top} wait_type, waiting_tasks_count, wait_time_ms, max_wait_time_ms, signal_wait_time_ms FROM sys.dm_os_wait_stats WHERE wait_type NOT IN (${filterClause}) AND waiting_tasks_count > 0 ORDER BY wait_time_ms DESC`;

			if (consola.level >= 0) logger.info(`Fetching top ${top} wait stats`);
			let results;
			try {
				results = await pool.query(query);
			} catch (e) {
				if (isPermissionError(e)) return permissionDeniedResponse('get_wait_stats', 'VIEW SERVER STATE');
				throw e;
			}

			if (!results || results.length === 0) return plainResponse('No significant wait stats. (Server may have been recently restarted.)');
			return plainResponse(formatCSV(results));
		} catch (error) {
			if (consola.level >= 0) logger.error('get_wait_stats error:', error);
			return errorResponse('Error fetching wait stats', error);
		}
	},

	clearCachesForTesting(): void {
		jobsCache.clear();
		jobHistoryCache.clear();
	},
};
