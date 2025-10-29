import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

/**
 * File-based logger for STDIO mode debugging
 * This logger writes to a file even when console logging is disabled
 * to help diagnose issues on Windows and other platforms.
 *
 * DEFAULT: Logging is ENABLED by default and writes to project root directory
 * To disable: Set MSSQL_MCP_FILE_LOG=false
 */
export class FileLogger {
	private logFilePath: string;
	private isEnabled: boolean;
	private logStream: fs.WriteStream | null = null;

	constructor() {
		// Enable file logging by default (disable with MSSQL_MCP_FILE_LOG=false)
		this.isEnabled = process.env.MSSQL_MCP_FILE_LOG !== 'false';

		// Determine log file location
		let logDir: string;
		if (process.env.MSSQL_MCP_LOG_DIR) {
			// Use custom directory if specified
			logDir = process.env.MSSQL_MCP_LOG_DIR;
		} else {
			// Default: Use logs/ subdirectory in project root
			try {
				const currentDir = process.cwd();
				logDir = path.join(currentDir, 'logs');
			} catch {
				// Fallback to temp directory if we can't determine project root
				logDir = os.tmpdir();
			}
		}

		const logFileName = `mssql-mcp-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
		this.logFilePath = path.join(logDir, logFileName);

		if (this.isEnabled) {
			try {
				// Ensure log directory exists
				const logDirPath = path.dirname(this.logFilePath);
				if (!fs.existsSync(logDirPath)) {
					fs.mkdirSync(logDirPath, { recursive: true });
				}

				// Create write stream with append mode
				this.logStream = fs.createWriteStream(this.logFilePath, {
					flags: 'a',
					encoding: 'utf8',
				});

				this.log('info', '=== MSSQL MCP Server File Logger Initialized ===');
				this.log('info', `Log file: ${this.logFilePath}`);
				this.log('info', `Platform: ${process.platform}`);
				this.log('info', `Node version: ${process.version}`);
				this.log('info', `Working directory: ${process.cwd()}`);
				this.log('info', `Logging enabled by default. To disable: Set MSSQL_MCP_FILE_LOG=false`);
			} catch (error) {
				// If we can't create the log file, disable logging
				this.isEnabled = false;
				console.error(`Failed to initialize file logger: ${error}`);
			}
		}
	}

	private formatMessage(level: string, message: string, data?: any): string {
		const timestamp = new Date().toISOString();
		const dataStr = data !== undefined ? ` | ${JSON.stringify(data, null, 2)}` : '';
		return `[${timestamp}] [${level.toUpperCase()}] ${message}${dataStr}\n`;
	}

	log(level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: any) {
		if (!this.isEnabled || !this.logStream) {
			return;
		}

		try {
			const formattedMessage = this.formatMessage(level, message, data);
			this.logStream.write(formattedMessage);
		} catch (error) {
			// Silently fail - we don't want logging errors to break the application
		}
	}

	info(message: string, data?: any) {
		this.log('info', message, data);
	}

	warn(message: string, data?: any) {
		this.log('warn', message, data);
	}

	error(message: string, data?: any) {
		this.log('error', message, data);
	}

	debug(message: string, data?: any) {
		this.log('debug', message, data);
	}

	getLogFilePath(): string | null {
		return this.isEnabled ? this.logFilePath : null;
	}

	close() {
		if (this.logStream) {
			this.log('info', '=== MSSQL MCP Server File Logger Closing ===');
			this.logStream.end();
			this.logStream = null;
		}
	}
}

// Singleton instance
let fileLoggerInstance: FileLogger | null = null;

export function getFileLogger(): FileLogger {
	if (!fileLoggerInstance) {
		fileLoggerInstance = new FileLogger();
	}
	return fileLoggerInstance;
}

export function closeFileLogger() {
	if (fileLoggerInstance) {
		fileLoggerInstance.close();
		fileLoggerInstance = null;
	}
}
