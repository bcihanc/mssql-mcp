import { Command } from 'commander';
import consola from 'consola';
import { config as dotenvConfig } from 'dotenv';
import { MssqlMcpServer } from './server/MssqlMcpServer';
import { getFileLogger, closeFileLogger } from './utils/fileLogger';

const program = new Command();

// Set up the main program as serve command (default)
program
	.name('mssql-mcp')
	.description('Microsoft SQL Server MCP Server')
	.version('1.0.0')
	.option('-v, --verbose', 'enable verbose logging')
	.option('--env-file <path>', 'load environment variables from file')
	.option('-p, --port <port>', 'HTTP server port', '3003')
	.option('-h, --host <host>', 'HTTP server host', 'localhost')
	.option('--stdio', 'use STDIO transport instead of HTTP')
	.action(async (options) => {
		const fileLogger = getFileLogger();

		try {
			// Set verbose logging level first
			if (options.verbose) {
				consola.level = 4; // Debug level
			}

			// When using STDIO, disable logging to avoid interfering with MCP communication
			if (options.stdio) {
				consola.level = -1; // Disable all logging

				fileLogger.info('STDIO mode enabled, console logging disabled');
				fileLogger.info('Environment variables:', {
					MSSQL_SERVER: process.env.MSSQL_SERVER || 'NOT SET',
					MSSQL_DATABASE: process.env.MSSQL_DATABASE || 'NOT SET',
					MSSQL_USER: process.env.MSSQL_USER ? '***SET***' : 'NOT SET',
					MSSQL_PASSWORD: process.env.MSSQL_PASSWORD ? '***SET***' : 'NOT SET',
					MSSQL_WINDOWS_AUTH: process.env.MSSQL_WINDOWS_AUTH || 'NOT SET',
					MSSQL_PORT: process.env.MSSQL_PORT || 'NOT SET',
					MSSQL_ENCRYPT: process.env.MSSQL_ENCRYPT || 'NOT SET',
				});

				// NOTE: Do NOT configure STDIO encoding here!
				// The MCP SDK's StdioServerTransport handles STDIN/STDOUT configuration itself.
				// Configuring encoding before the transport is created will prevent it from reading messages.
				fileLogger.info('Letting MCP SDK handle STDIO configuration');
			}

			// Load environment file if specified using dotenv - AFTER stdio check
			if (options.envFile) {
				fileLogger.info(`Loading environment file: ${options.envFile}`);
				const result = dotenvConfig({ path: options.envFile });
				if (result.error) {
					fileLogger.error('Failed to load environment file', result.error);
					consola.error(`Failed to load environment file: ${options.envFile}`, result.error);
					process.exit(1);
				}
				fileLogger.info('Environment file loaded successfully');
				if (!options.stdio) {
					consola.success(`Loaded environment variables from: ${options.envFile}`);
				}
			}

			if (!options.stdio) {
				consola.info('Starting MSSQL MCP server...');
			}

			fileLogger.info('Creating MssqlMcpServer instance', {
				port: parseInt(options.port),
				host: options.host,
				stdio: options.stdio,
			});

			const server = new MssqlMcpServer({
				port: parseInt(options.port),
				host: options.host,
				stdio: options.stdio,
			});

			fileLogger.info('Starting MssqlMcpServer...');
			await server.start();
			fileLogger.info('MssqlMcpServer started successfully');

			if (!options.stdio) {
				consola.success(`MSSQL MCP server started on http://${options.host}:${options.port}`);
			}

			// Keep the process running
			process.on('SIGINT', async () => {
				fileLogger.info('Received SIGINT, shutting down...');
				if (!options.stdio) {
					consola.info('Shutting down MSSQL MCP server...');
				}
				await server.stop();
				closeFileLogger();
				process.exit(0);
			});

			process.on('SIGTERM', async () => {
				fileLogger.info('Received SIGTERM, shutting down...');
				if (!options.stdio) {
					consola.info('Shutting down MSSQL MCP server...');
				}
				await server.stop();
				closeFileLogger();
				process.exit(0);
			});
		} catch (error) {
			fileLogger.error('Failed to start MSSQL MCP server', error);
			consola.error('Failed to start MSSQL MCP server:', error);
			closeFileLogger();
			process.exit(1);
		}
	});

// Global error handling
process.on('unhandledRejection', (error) => {
	const fileLogger = getFileLogger();
	fileLogger.error('Unhandled promise rejection', error);
	consola.error('Unhandled promise rejection:', error);
	closeFileLogger();
	process.exit(1);
});

process.on('uncaughtException', (error) => {
	const fileLogger = getFileLogger();
	fileLogger.error('Uncaught exception', error);
	consola.error('Uncaught exception:', error);
	closeFileLogger();
	process.exit(1);
});

// Parse command line arguments
program.parse();

// If no command is provided, show help
if (!process.argv.slice(2).length) {
	program.outputHelp();
}
