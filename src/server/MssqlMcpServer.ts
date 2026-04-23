import { StreamableHTTPTransport } from '@hono/mcp';
import { serve, type HttpBindings } from '@hono/node-server';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import consola from 'consola';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { MssqlObjectTools } from '../MssqlObjectTools.js';
import { MssqlProfilingTools } from '../MssqlProfilingTools.js';
import { MssqlResources } from '../MssqlResources';
import { MssqlServerTools } from '../MssqlServerTools.js';
import { MssqlTools } from '../MssqlTools';
import { getFileLogger } from '../utils/fileLogger';
import { getMssqlConfig } from './config';
import { createResilientConnectionPool, ResilientConnectionPool } from './connection';

export interface MssqlMcpServerConfig {
	port?: number;
	host?: string;
	stdio?: boolean;
}

const serverLogger = consola.withTag('mssql-mcp-server');

export class MssqlMcpServer {
	private server: Server;
	private app?: Hono<any>;
	private httpServer?: any;
	private pool?: ResilientConnectionPool;
	private config: Required<MssqlMcpServerConfig>;
	private httpTransport?: StreamableHTTPTransport;
	private configError?: string;

	constructor(config: MssqlMcpServerConfig = {}) {
		this.config = {
			port: config.port ?? 3003,
			host: config.host ?? 'localhost',
			stdio: config.stdio ?? false,
		};

		// Create MCP server using original SDK approach
		this.server = new Server(
			{
				name: 'mssql-mcp-server',
				version: '1.0.0',
			},
			{
				capabilities: {
					tools: {},
					resources: {},
				},
			},
		);

		this.setupHandlers();
	}

	private setupHandlers() {
		// Tool handlers
		this.server.setRequestHandler(ListToolsRequestSchema, async () => {
			const tools = [
				...MssqlTools.getToolDefinitions(),
				...MssqlObjectTools.getToolDefinitions(),
				...MssqlServerTools.getToolDefinitions(),
				...MssqlProfilingTools.getToolDefinitions(),
			];
			return { tools };
		});

		this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
			if (this.configError) {
				return {
					content: [{ type: 'text' as const, text: `Error: Database configuration failed: ${this.configError}` }],
					isError: true,
				};
			}
			if (!this.pool) {
				return {
					content: [{ type: 'text' as const, text: 'Error: Database connection is not yet initialized. Please try again shortly.' }],
					isError: true,
				};
			}

			const { name, arguments: args } = request.params;
			if (MssqlObjectTools.canHandle(name)) {
				return await MssqlObjectTools.handleTool(name, args, this.pool);
			}
			if (MssqlServerTools.canHandle(name)) {
				return await MssqlServerTools.handleTool(name, args, this.pool);
			}
			if (MssqlProfilingTools.canHandle(name)) {
				return await MssqlProfilingTools.handleTool(name, args, this.pool);
			}
			return await MssqlTools.handleTool(name, args, this.pool);
		});

		// Resource handlers
		this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
			if (!this.pool) {
				return { resources: [] };
			}

			const resources = await MssqlResources.getResourceDefinitions(this.pool);
			return { resources };
		});

		this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
			if (!this.pool) {
				throw new Error('Database connection is not yet initialized. Please try again shortly.');
			}

			const { uri } = request.params;
			const contents = await MssqlResources.handleResource(uri, this.pool);
			return { contents: [contents] };
		});
	}

	async start() {
		const fileLogger = getFileLogger();
		fileLogger.info('MssqlMcpServer.start() called');

		// CRITICAL: Set up MCP transport FIRST — before anything else.
		// This ensures the server process stays alive and responsive to the MCP client
		// regardless of database configuration or connection issues.
		if (this.config.stdio) {
			fileLogger.info('Setting up STDIO transport...');
			try {
				const transport = new StdioServerTransport();
				await this.server.connect(transport);
				fileLogger.info('STDIO transport connected successfully');
			} catch (error) {
				fileLogger.error('Failed to setup STDIO transport', error);
				throw error;
			}
		} else {
			this.app = new Hono<{
				Bindings: HttpBindings;
			}>();

			this.app.use(logger());

			this.app.use(
				'*',
				cors({
					origin: ['https://claude.ai'],
					allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
					allowHeaders: ['Content-Type', 'Authorization'],
				}),
			);

			this.app.get('/health', (c) => {
				return c.json({
					status: 'healthy',
					database: this.pool?.isConnected ? 'connected' : 'disconnected',
					timestamp: new Date().toISOString(),
					service: 'mssql-mcp-server',
					version: '1.0.0',
				});
			});

			this.httpTransport = new StreamableHTTPTransport();
			await this.server.connect(this.httpTransport);

			this.app.all('/mcp', async (c) => {
				return this.httpTransport!.handleRequest(c);
			});

			this.httpServer = serve({
				fetch: this.app.fetch,
				port: this.config.port,
				hostname: this.config.host,
			});

			serverLogger.info(`MSSQL MCP server started on http://${this.config.host}:${this.config.port}`);
		}

		// Now that transport is alive, initialize database connection in the background.
		// Config errors and connection failures are non-fatal — tool calls will show the error.
		this.initializeDatabase(fileLogger);
	}

	/**
	 * Initialize database configuration and connection pool.
	 * Runs AFTER transport is set up. Never throws — errors are stored
	 * and surfaced through tool call responses.
	 */
	private initializeDatabase(fileLogger: ReturnType<typeof getFileLogger>): void {
		fileLogger.info('Getting database configuration...');
		let dbConfig;
		try {
			dbConfig = getMssqlConfig();
			fileLogger.info('Database configuration retrieved', {
				server: dbConfig.server,
				database: dbConfig.database,
				port: dbConfig.port,
				encrypt: dbConfig.encrypt,
				windowsAuth: dbConfig.windowsAuth,
				hasUser: !!dbConfig.user,
				hasPassword: !!dbConfig.password,
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this.configError = errorMsg;
			fileLogger.error('Failed to get database configuration', error);
			if (!this.config.stdio) {
				serverLogger.error(`Database configuration failed: ${errorMsg}`);
			}
			return; // Don't attempt connection — config is invalid
		}

		// Create resilient pool
		try {
			this.pool = createResilientConnectionPool(dbConfig);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this.configError = errorMsg;
			fileLogger.error('Failed to create connection pool', error);
			if (!this.config.stdio) {
				serverLogger.error(`Failed to create connection pool: ${errorMsg}`);
			}
			return;
		}

		// Fire-and-forget: attempt eager connection in background
		// This does NOT block start() — the MCP server is already responsive
		this.pool.ensureConnected().then((connected) => {
			if (connected) {
				fileLogger.info('Database connection established successfully');
				if (!this.config.stdio) {
					serverLogger.success('Database connection established successfully');
				}
			} else {
				// ensureConnected() automatically starts background retry on failure
				fileLogger.warn('Database is currently unavailable — server will retry automatically');
				if (!this.config.stdio) {
					serverLogger.warn('Database is currently unavailable. The server will automatically reconnect when the database becomes available.');
				}
			}
		});
	}

	async stop() {
		if (this.httpServer) {
			this.httpServer.close();
			if (!this.config.stdio) {
				serverLogger.info('HTTP server stopped');
			}
		}

		if (this.server) {
			await this.server.close();
			if (!this.config.stdio) {
				serverLogger.info('MCP server stopped');
			}
		}

		if (this.pool) {
			await this.pool.close();
			if (!this.config.stdio) {
				serverLogger.info('Database connection pool closed');
			}
		}
	}
}
