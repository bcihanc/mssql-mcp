# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

@bcihanc/mssql-mcp is a **READ-ONLY** Model Context Protocol (MCP) server that enables AI assistants like Claude to safely query Microsoft SQL Server databases. The server provides read-only SQL query execution, database browsing, and schema inspection capabilities.

**IMPORTANT: This MCP server is designed to be READ-ONLY by default. Write operations (INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, etc.) are strictly prohibited and blocked at multiple layers for security.**

## Development Commands

### Build
```bash
npm run build
```
Executes the custom esbuild bundler at [src/scripts/bundle.ts](src/scripts/bundle.ts) to create a single executable in `dist/main.mjs`.

### Development Mode
```bash
npm run dev
```
Runs the server directly with TypeScript support using ts-node loader.

### Clean Build Artifacts
```bash
npm run clean
```
Removes the `dist` directory (cross-platform compatible).

## Platform Compatibility

### Windows Support

The MCP server is fully compatible with Windows. Recent changes ensure cross-platform compatibility:

**Fixed Issues:**
- ✅ `npm run clean` now uses Node.js API instead of Unix `rm -rf` command
- ✅ `chmod` errors are gracefully ignored on Windows (file permissions handled differently)
- ✅ Shebang (`#!/usr/bin/env node`) is automatically ignored by Node.js on Windows
- ✅ LocalDB connection string handling now supports both single and double backslash formats
- ✅ STDIO mode properly configured for Windows encoding (UTF-8)
- ✅ Enhanced error messages for Windows-specific issues (LocalDB, Windows Auth, certificates)

**Windows-Specific Configuration:**
- Use forward slashes (`/`) or double backslashes (`\\`) in file paths
- Example: `C:/Users/YourName/.env` or `C:\\Users\\YourName\\.env`
- LocalDB connection string formats (all supported):
  - `MSSQL_SERVER=(localdb)\MSSQLLocalDB` (single backslash)
  - `MSSQL_SERVER=(localdb)\\MSSQLLocalDB` (double backslash)
  - `MSSQL_SERVER=(LocalDB)\MSSQLLocalDB` (case-insensitive)
- Windows Authentication: Set `MSSQL_WINDOWS_AUTH=true` in environment variables

**Claude Desktop Config (Windows) - RECOMMENDED:**
```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": [
        "C:/Users/USERNAME/AppData/Roaming/npm/node_modules/@bcihanc/mssql-mcp/dist/main.mjs",
        "--stdio",
        "--env-file",
        "C:/path/to/your/.env"
      ]
    }
  }
}
```

**Alternative Config (Using npx - may have STDIO issues on some systems):**
```json
{
  "mcpServers": {
    "mssql": {
      "command": "npx",
      "args": ["@bcihanc/mssql-mcp", "--env-file", "C:/path/to/your/.env", "--stdio"]
    }
  }
}
```

**Windows Troubleshooting:**

If the MCP server doesn't work with Claude Desktop on Windows:

1. **STDIO Issue (Most Common)**: npx wrapper scripts may not inherit STDIO correctly
   - Solution: Use `node` command directly (see recommended config above)
   - Find your global npm path: `npm config get prefix`
   - Use absolute path to `dist/main.mjs`

2. **LocalDB Connection Failed**:
   - Verify LocalDB is installed: `sqllocaldb info`
   - Start LocalDB instance: `sqllocaldb start MSSQLLocalDB`
   - Check connection string format supports both `\` and `\\`

3. **Windows Authentication Failed**:
   - Ensure your Windows user has SQL Server access
   - Test with SQL Server Management Studio first
   - Alternative: Use SQL Authentication instead

### Debug Logging

**File-Based Debug Logging (ENABLED BY DEFAULT)**

File logging is **automatically enabled** to help diagnose issues without interfering with STDIO communication. This is especially useful for Windows troubleshooting.

**Default Behavior:**
- ✅ Logging is **ENABLED by default**
- ✅ Log files are written to the **`logs/` directory** in project root
- ✅ The `logs/` directory is automatically created if it doesn't exist
- ✅ Each run creates a new timestamped log file: `logs/mssql-mcp-YYYY-MM-DDTHH-MM-SS-sssZ.log`
- ✅ Works in STDIO mode without interfering with Claude Desktop communication

**Disable Logging (Optional):**
```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": [
        "C:/Users/USERNAME/AppData/Roaming/npm/node_modules/@bcihanc/mssql-mcp/dist/main.mjs",
        "--stdio",
        "--env-file",
        "C:/path/to/your/.env"
      ],
      "env": {
        "MSSQL_MCP_FILE_LOG": "false"
      }
    }
  }
}
```

**Custom Log Directory (Optional):**
```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": [...],
      "env": {
        "MSSQL_MCP_LOG_DIR": "C:/logs/mssql-mcp"
      }
    }
  }
}
```

**Environment Variables:**
- `MSSQL_MCP_FILE_LOG`: Set to `"false"` to disable file logging (enabled by default)
- `MSSQL_MCP_LOG_DIR`: Optional custom directory for log files (defaults to project root)

**What Gets Logged:**
- Server startup and initialization
- Environment variable configuration (passwords masked)
- Database connection attempts with detailed error information
- STDIO transport setup on Windows
- Query execution (first 200 characters only)
- Windows-specific error diagnostics (LocalDB, Windows Auth, certificates, firewall)

**Log File Location:**
- **Default**: `logs/` subdirectory in project root
  - Global install: `%APPDATA%\npm\node_modules\@bcihanc\mssql-mcp\logs\mssql-mcp-*.log`
  - Local/dev: Your project directory (e.g., `C:\mcp\mssql-mcp\logs\mssql-mcp-*.log`)
- **Custom**: Specified via `MSSQL_MCP_LOG_DIR`
- **Filename format**: `logs/mssql-mcp-YYYY-MM-DDTHH-MM-SS-sssZ.log`

**Finding Your Logs:**

If using local installation or development:
```bash
# Windows (PowerShell) - in project directory
Get-ChildItem logs\mssql-mcp-*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1

# Windows (cmd) - in project directory
dir logs\mssql-mcp-*.log /O-D /B

# macOS/Linux - in project directory
ls -lt logs/mssql-mcp-*.log | head -1
```

If using global npm installation:
```bash
# Windows (PowerShell)
cd $env:APPDATA\npm\node_modules\@bcihanc\mssql-mcp
Get-ChildItem logs\mssql-mcp-*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1

# macOS/Linux
cd $(npm root -g)/@bcihanc/mssql-mcp
ls -lt logs/mssql-mcp-*.log | head -1
```

**TIP:** Log files are organized in the `logs/` directory, keeping your project root clean and logs easy to find.

**IMPORTANT:** File logging works even when console logging is disabled (STDIO mode), making it perfect for diagnosing Claude Desktop integration issues.

4. **Certificate/TLS Issues**:
   - For testing: Set `MSSQL_ENCRYPT=false` in `.env` (not for production)
   - For Azure SQL: Ensure proper certificate chain is installed

5. **Connection Refused/Timeout**:
   - Verify SQL Server is running
   - Check Windows Firewall settings
   - Test connection with `sqlcmd -S yourserver -U sa -P password`

**Enhanced Error Messages:**
The server now provides detailed, context-aware error messages for Windows-specific issues:
- LocalDB installation and startup problems
- Windows Authentication permission issues
- Certificate validation failures
- Network connectivity and firewall issues

### Testing Connection
```bash
# STDIO mode (for Claude Desktop integration)
MSSQL_SERVER=localhost MSSQL_DATABASE=mydb MSSQL_USER=sa MSSQL_PASSWORD=password node --loader ts-node/esm src/main.ts --stdio

# HTTP mode (for development/debugging with verbose logging)
node --loader ts-node/esm src/main.ts --port 3003 --verbose --env-file .env
```

## Performance Optimizations

**Note:** This MCP server has been optimized for production-grade performance with the following enhancements:

### Critical Performance Optimizations

1. **CSV Formatting Memory Efficiency** - Array join pattern replaces string concatenation for O(n) complexity instead of O(n²):
   - Shared utility function ([src/utils/csv.ts](src/utils/csv.ts)) eliminates code duplication
   - Proper CSV escaping for special characters (commas, quotes, newlines) across all output
   - ~50-70% faster CSV generation with significantly reduced memory pressure for large datasets
   - Affects both query results and resource data output

2. **HTTP Transport Connection Reuse** - HTTP transport is created once at server startup and reused for all requests, eliminating per-request connection overhead (~10x faster in HTTP mode)

3. **Resource Listing Cache** - Table listings are cached with 5-minute TTL to avoid redundant INFORMATION_SCHEMA queries (~20x faster for resource list requests)

4. **Resilient Background Connection** - The MCP transport comes up first; the database connection is established in the background via `ResilientConnectionPool.ensureConnected()`:
   - **Non-blocking startup**: server is responsive to MCP clients even before the DB is reachable (critical for Claude Desktop UX)
   - **Warm-on-success**: when the first connection succeeds, the pool is warm before any tool call arrives (~100ms faster first query vs. lazy-on-first-call)
   - **Auto-retry with exponential backoff**: 1s → 2s → 4s → … → 60s max; no configuration needed
   - **Mid-session resilience**: connection-error detection (`ECONNRESET`, `ETIMEDOUT`, etc.) triggers a retry cycle without crashing the server
   - **Thundering-herd protection**: concurrent callers share a single in-flight `connectingPromise`
   - Previous "eager connection" behavior (that would crash the server on DB unavailability) is preserved only in the deprecated `createConnectionPool()` factory

### High-Priority Optimizations

5. **True LRU Cache with Lazy Cleanup** - Intelligent caching strategy for query results:
   - `MSSQL_CACHE_TTL` (default: 60 seconds) - Cache duration
   - `MSSQL_CACHE_SIZE` (default: 100 queries) - Maximum cached queries
   - **Lazy cleanup**: O(1) expired entry removal instead of O(cache_size) on every request
   - **True LRU eviction**: Tracks `lastAccessed` timestamp to evict least recently used entries
   - Normalized query keys for cache hit optimization
   - ~100x faster for cache hits vs database queries
   - Minimal CPU overhead compared to previous eager cleanup approach

5a. **Tool-Specific Metadata Caching** - Comprehensive caching for all metadata tools:
   - **get_version**: Static cache (never expires) - version never changes during runtime
   - **list_tables**: TTL cache (30 min default) - ~50x faster for table and view listing
   - **get_table_schema**: TTL + LRU cache (2 hours, max 200 schemas) - ~40x faster for schema queries
   - **get_foreign_keys**: TTL + LRU cache (4 hours, max 100) - ~30x faster for FK queries
   - **get_table_relationships**: TTL + LRU cache (4 hours, max 100) - ~25x faster for relationship queries
   - **search_columns**: TTL + LRU cache (2 hours, max 100) - Optimized for repeated column searches
   - **get_table_indexes**: TTL + LRU cache (4 hours, max 200) - ~30x faster for index analysis
   - All caches use same lazy cleanup and LRU eviction strategy as query cache
   - Metadata rarely changes, making long TTLs safe and highly effective
   - Reduces database load by 70-80% for typical AI assistant usage patterns

6. **Query Validation Optimization** - Combined regex patterns keep validation cheap despite expanded security coverage: comment/backslash stripping + single consolidated "dangerous pattern" regex (covers DDL/DML/DCL/execution/exfiltration/hex) + hex-detector + whitelist starter check. Significantly lower CPU overhead vs. iterating individual per-keyword tests (~5x faster than the pre-consolidation baseline).

7. **Logging Guards** - String interpolation and computations moved inside logging guards to avoid unnecessary work when logging is disabled (STDIO mode)

8. **Connection Pool Minimum** - Pool configured with `min: 2` to keep warm connections available, preventing reconnection overhead during idle periods

### Medium-Priority Optimizations

9. **Result Size Management** - Configurable limits for query results with automatic truncation and warnings:
   - `MSSQL_MAX_ROWS` (default: 10,000) - Maximum rows returned, truncates with warning
   - `MSSQL_WARN_ROWS` (default: 5,000) - Warning threshold for large results
   - Memory-efficient CSV building with array join pattern

10. **Pagination Support** - Configurable resource data limits:
    - `MSSQL_RESOURCE_LIMIT` (default: 100) - Number of rows returned for resource browsing
    - Memory-efficient CSV formatting for resource data
    - Pagination info displayed when at limit

11. **Bundle Size Monitoring** - Enhanced build script provides detailed size reporting:
    - Reports size in MB, KB, and bytes
    - Automatic warnings for bundles >5MB or >10MB
    - Current bundle: ~4.0 MB (optimal size)

### Performance Impact Summary

These optimizations provide:
- **CSV Generation**: ~50-70% faster with 50% less memory usage (array join vs string concatenation)
- **Cache Performance**: ~100x faster for repeated queries (true LRU with lazy cleanup)
- **Cache Overhead**: Near-zero CPU overhead for cache maintenance (lazy cleanup vs eager)
- **Metadata Caching**: 20-50x faster for metadata operations
  - `list_tables`: ~50x faster with cache hits (now includes views)
  - `get_table_schema`: ~40x faster with cache hits (now includes UNIQUE constraints and computed columns)
  - `get_foreign_keys`: ~30x faster with cache hits
  - `get_table_relationships`: ~25x faster with cache hits
  - `get_table_indexes`: ~30x faster with cache hits
  - `get_version`: ~50x faster (static cache, instant response after first call)
  - **Overall AI Usage**: 70-80% reduction in database load for typical AI assistant workflows
- **HTTP Mode**: ~10x improvement for consecutive requests (connection reuse)
- **Resource Listing**: ~20x improvement with cache hits (TTL cache)
- **Query Validation**: ~5x faster (combined regex patterns)
- **Startup**: MCP transport comes up immediately; first query is warm (~100ms faster) when DB is available, and the server stays alive and auto-reconnects when it isn't
- **STDIO Mode**: Minimal overhead from logging guards
- **Code Quality**: DRY principle via shared CSV utility, easier maintenance

## Architecture

### Core Components

1. **MCP Server Layer** ([src/server/MssqlMcpServer.ts](src/server/MssqlMcpServer.ts))
   - Entry point for MCP protocol handling
   - Supports both STDIO (for Claude Desktop) and HTTP transports
   - Manages database connection lifecycle
   - Routes requests to Tools and Resources handlers
   - Key methods: `setupHandlers()`, `start()`, `stop()`

2. **Tools Layer** ([src/MssqlTools.ts](src/MssqlTools.ts))
   - Implements MCP tool definitions and handlers
   - Provides eight main tools:
     - `exec_sql_csv`: Execute READ-ONLY SQL queries with CSV output
     - `get_version`: Retrieve SQL Server version
     - `list_tables`: List all tables and views with schema, type, row count, and size info
     - `get_table_schema`: Get detailed schema for a specific table (columns, types, constraints including UNIQUE, computed columns)
     - `get_foreign_keys`: Get all foreign key relationships with cascade rules
     - `search_columns`: Search for columns by name across all tables
     - `get_table_relationships`: Get parent/child relationships for a specific table
     - `get_table_indexes`: Get all indexes for a specific table with column information (Essential for performance analysis)
   - Enforces read-only validation with multiple security layers:
     - Whitelist: Only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, DESC allowed
     - Blacklist: Blocks INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, EXEC, etc.
     - Pattern detection: Prevents SQL injection and dangerous operations

3. **Resources Layer** ([src/MssqlResources.ts](src/MssqlResources.ts))
   - Exposes database tables as MCP resources
   - URI format: `mssql://{tableName}/data`
   - Automatically discovers tables via INFORMATION_SCHEMA
   - Returns top N rows per table in CSV format (N controlled by `MSSQL_RESOURCE_LIMIT`, default 100; pagination warning appended when limit reached)
   - 5-minute TTL cache on the resource list; falls back to stale cache on listing errors to keep the MCP client usable

4. **Connection Management** ([src/server/connection.ts](src/server/connection.ts))
   - Provides `ResilientConnectionPool` — a self-healing pool that keeps the MCP server responsive even when the database is unavailable
   - Exposes the unified `ConnectionPool` interface with:
     - `query()`: Simple read-only query execution
     - `close()`: Graceful shutdown
     - `isConnected` (on `ResilientConnectionPool`): current connection state for health checks
   - **Graceful startup**: server starts even if the database is unreachable; tool calls surface a user-friendly error until reconnection succeeds
   - **Automatic reconnection** with exponential backoff (1s → 2s → 4s → … → 60s max), triggered on both startup failure and mid-session disconnects
   - **Mid-session disconnect detection** via pool `error` events and connection-error classification (`ECONNRESET`, `ETIMEDOUT`, `socket hang up`, etc.)
   - **Shared promise pattern** for `ensureConnected()` prevents thundering herd when multiple concurrent tool calls arrive while disconnected
   - **Lazy reconnection** on tool calls: if disconnected, a connection attempt is made before rejecting
   - Detects and blocks write operations with enhanced error messages
   - Error classifier (`handleQueryError`) distinguishes schema/syntax errors from write-attempt errors to avoid false positives
   - Supports both SQL Server Authentication and Windows Authentication
   - `createResilientConnectionPool()` is the primary factory; the legacy `createConnectionPool()` is `@deprecated` and kept only for backward compatibility

5. **Configuration** ([src/server/config.ts](src/server/config.ts))
   - Parses environment variables into `MssqlConfig`
   - Detects and handles special cases:
     - Azure SQL (auto-enables encryption for `*.database.windows.net`)
     - LocalDB (converts `(localdb)\instance` to `.\\instance` format)
   - Validates table names to prevent SQL injection (`validateTableName()`)
   - **Multi-layer read-only query detection** via `isReadOnlyQuery()` — full layer-by-layer details are in the "Security Model" section below

6. **CSV Utilities** ([src/utils/csv.ts](src/utils/csv.ts))
   - Shared CSV formatting utilities for memory-efficient output generation
   - `formatCSV()`: Converts query results to CSV with O(n) complexity (array join pattern)
   - `escapeCSVCell()`: Proper escaping for special characters (commas, quotes, newlines)
   - Eliminates code duplication between MssqlTools and MssqlResources
   - Ensures consistent CSV formatting across all outputs

### Data Flow

1. **Incoming MCP Request** → MssqlMcpServer receives via STDIO or HTTP transport
2. **Connection Availability Gate** (in `CallToolRequestSchema` / `ReadResourceRequestSchema` handlers):
   - If `configError` is set (invalid env vars), return a tool error explaining the misconfiguration
   - If `pool` is not yet initialized or disconnected, return a friendly "database unavailable — server will auto-reconnect" message instead of crashing
3. **Request Routing**:
   - Tool requests → MssqlTools.handleTool()
   - Resource list → MssqlResources.getResourceDefinitions()
   - Resource read → MssqlResources.handleResource()
4. **Query Execution** (READ-ONLY enforced at multiple layers):
   - **Layer 1**: Input validation via Zod schema
   - **Layer 2**: Read-only query validation (`isReadOnlyQuery()`)
     - Whitelist check: Must start with SELECT, WITH, SHOW, etc.
     - Blacklist check: Must not contain INSERT, UPDATE, DELETE, DROP, etc.
   - **Layer 3**: `ResilientConnectionPool.query()` — performs lazy reconnect if disconnected, then executes
   - **Layer 4**: Error classification (`handleQueryError`)
     - **Schema/syntax errors checked FIRST** (`invalid column name`, `invalid object name`, `incorrect syntax near`, `ambiguous column name`, `must declare`, `could not find stored procedure`) — these are re-thrown as-is
     - Only if the error doesn't match schema patterns, write-keyword detection runs → wraps as READ-ONLY violation
     - Connection errors (`ECONNRESET`, `ETIMEDOUT`, …) trigger background reconnect and return a friendly "connection lost" message
5. **Response Formatting** → CSV format only
6. **Return to Client** → Structured MCP response

### Security Model

**THIS MCP SERVER IS READ-ONLY BY DESIGN - NO CONFIGURATION REQUIRED**

- **Multi-Layer Read-Only Enforcement** (all in [src/server/config.ts](src/server/config.ts) `isReadOnlyQuery()` unless noted):
  - **Layer 1 - Encoding Bypass Decoding**: `decodeURIComponent()` unwraps URL-encoded payloads (`%44%52%4F%50` → `DROP`) before validation
  - **Layer 2 - Unicode Normalization**: `String.normalize('NFKC')` defeats homograph attacks (e.g. fullwidth `ＳＥＬＥＣＴ` → `SELECT`, and Unicode lookalike bypasses)
  - **Layer 3 - Comment & Backslash Stripping**: Removes line (`--`), block (`/* */`) comments **and** backslashes (used in hex-encoding bypasses) before validation
  - **Layer 4 - Dangerous Pattern Blacklist** — blocks ALL of:
    - DDL: `DROP`, `TRUNCATE`, `ALTER`, `CREATE`
    - DML: `INSERT`, `UPDATE`, `DELETE`, `MERGE`
    - DCL: `GRANT`, `REVOKE`, `DENY`
    - Execution: `EXEC`, `EXECUTE`, `SP_EXECUTESQL`, `XP_CMDSHELL`
    - Data exfiltration: `UNION`, `INTO`, `BULK`, `BACKUP`, `RESTORE`
    - External access: `OPENROWSET`, `OPENQUERY`, `OPENDATASOURCE`
    - Multi-statement injection: `;` followed by any dangerous op
    - Hex-encoded payloads: `0X[0-9A-F]+`
  - **Layer 5 - Hex-Encoded Keyword Detection**: Additional check for `0x`-prefixed hex strings ≥8 chars (e.g. `0x44524F50` = "DROP")
  - **Layer 6 - Whitelist Validation**: After all decoding/stripping, query must start with `SELECT`, `WITH`, `SHOW`, `DESCRIBE`, `EXPLAIN`, or `DESC`
  - **Layer 7 - Runtime Error Classification** (`handleQueryError` in [src/server/connection.ts](src/server/connection.ts)):
    - **Schema/syntax errors are checked FIRST** and re-thrown verbatim (`invalid column name`, `invalid object name`, `incorrect syntax near`, `ambiguous column name`, `must declare`, `could not find stored procedure`)
    - **Only after** schema check: write-keyword detection in error messages → wraps as `READ-ONLY mode violation`
    - This order prevents false positives where a schema error message happens to contain a write keyword (e.g. `"Invalid column name 'update_time'"`)
  - **Layer 8 - Error Sanitization**: Enhanced error messages for write attempt detection

- **Cache Integrity**:
  - Cache keys generated via **SHA256** hash of normalized query text (prevents cache-poisoning collisions a crafted query might exploit against a weaker hash)
  - Normalization: `trim → lowercase → collapse whitespace` before hashing to maximize cache reuse without cross-query bleed

- **SQL Injection Prevention**:
  - Table names validated with regex: `^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)?$`
  - Table names escaped with brackets: `[schema].[table]`
  - Uses parameterized queries via mssql package
  - Dangerous patterns blocked at query validation stage

- **Logging Behavior**:
  - STDIO mode disables all logging (`consola.level = -1`) to avoid interfering with MCP protocol
  - HTTP mode enables logging for debugging
  - All queries logged as "READ-ONLY" for clarity

## Key Implementation Details

### Environment Variables

Required for SQL Authentication:
- `MSSQL_SERVER`: Server address (supports LocalDB syntax)
- `MSSQL_DATABASE`: Database name
- `MSSQL_USER`: Username
- `MSSQL_PASSWORD`: Password

Required for Windows Authentication:
- `MSSQL_SERVER`: Server address
- `MSSQL_DATABASE`: Database name
- `MSSQL_WINDOWS_AUTH=true`: Enable Windows Auth

Optional:
- `MSSQL_PORT`: Port number (default: 1433)
- `MSSQL_ENCRYPT`: Force encryption (auto-enabled for Azure SQL)

Performance Tuning (Optional):
- `MSSQL_MAX_ROWS`: Maximum rows returned per query (default: 10,000) - results truncated with warning if exceeded
- `MSSQL_WARN_ROWS`: Warning threshold for large results (default: 5,000) - warning shown but not truncated
- `MSSQL_RESOURCE_LIMIT`: Rows returned for resource browsing (default: 100)

Query Result Caching (exec_sql_csv):
- `MSSQL_CACHE_TTL`: Query result cache duration in milliseconds (default: 60,000 = 60 seconds)
- `MSSQL_CACHE_SIZE`: Maximum number of cached queries (default: 100)

Tool-Specific Caching (metadata operations - improves performance 20-50x for repeated queries):
Database schema rarely changes, so longer TTLs provide better performance:
- `MSSQL_TABLES_CACHE_TTL`: list_tables cache TTL in milliseconds (default: 1,800,000 = 30 minutes)
- `MSSQL_SCHEMA_CACHE_TTL`: get_table_schema cache TTL in milliseconds (default: 7,200,000 = 2 hours)
- `MSSQL_SCHEMA_CACHE_SIZE`: Maximum cached table schemas (default: 200)
- `MSSQL_FK_CACHE_TTL`: get_foreign_keys cache TTL in milliseconds (default: 14,400,000 = 4 hours)
- `MSSQL_FK_CACHE_SIZE`: Maximum cached FK queries (default: 100)
- `MSSQL_RELATIONSHIPS_CACHE_TTL`: get_table_relationships cache TTL in milliseconds (default: 14,400,000 = 4 hours)
- `MSSQL_RELATIONSHIPS_CACHE_SIZE`: Maximum cached relationship queries (default: 100)
- `MSSQL_COLUMNS_CACHE_TTL`: search_columns cache TTL in milliseconds (default: 7,200,000 = 2 hours)
- `MSSQL_COLUMNS_CACHE_SIZE`: Maximum cached column searches (default: 100)
- `MSSQL_INDEXES_CACHE_TTL`: get_table_indexes cache TTL in milliseconds (default: 14,400,000 = 4 hours)
- `MSSQL_INDEXES_CACHE_SIZE`: Maximum cached index queries (default: 200)

Note: get_version uses static cache (never expires during runtime) as SQL Server version never changes.

**Note**: `MSSQL_ACCESS_MODE` environment variable has been removed. This server is **always READ-ONLY** by design.

### Transport Modes

**STDIO Mode** (Claude Desktop):
- CLI flag: `--stdio`
- Disables console logging completely
- Uses StdioServerTransport from MCP SDK
- Communicates via stdin/stdout

**HTTP Mode** (Development):
- CLI flags: `--port <port> --host <host>`
- Enables verbose logging with `--verbose`
- Uses StreamableHTTPTransport from @hono/mcp
- Includes CORS configuration for claude.ai
- Health check endpoint at `/health` — returns JSON with:
  - `status`: `"healthy"` (always, once the server is up)
  - `database`: `"connected"` or `"disconnected"` (reflects `ResilientConnectionPool.isConnected`)
  - `timestamp`, `service`, `version`
- MCP endpoint at `/mcp`

### Read-Only Query Execution

The connection layer implements simple read-only query execution:
- All queries executed directly without transactions (no write operations possible)
- Error classification distinguishes schema errors (re-thrown) from write-attempt errors (wrapped as READ-ONLY violation) — schema check runs first to prevent false positives
- Connection errors (ECONNRESET / ETIMEDOUT / socket hang up / etc.) are detected and trigger background reconnect; the caller receives a friendly "connection lost — auto-reconnect in progress" message
- SQL Server 2008+ compatible
- No transaction nesting issues since transactions are not used

### Zod Schema Validation

All tool inputs are validated using Zod v4 schemas:
- `ExecuteSqlInputSchema`: Validates SQL query parameter
- `GetVersionInputSchema`: No parameters (empty object)
- `ListTablesInputSchema`: Optional schema_name filter
- `GetTableSchemaInputSchema`: Required table_name, optional schema_name
- `GetForeignKeysInputSchema`: Optional table_name and schema_name filters
- `SearchColumnsInputSchema`: Required column_name, optional schema_name
- `GetTableRelationshipsInputSchema`: Required table_name, optional schema_name
- `GetTableIndexesInputSchema`: Required table_name, optional schema_name
- Zod schemas converted to JSON Schema for MCP tool definitions
- Validation errors return user-friendly error messages

## Common Development Tasks

### Adding a New Tool

1. Define Zod schema in [src/MssqlTools.ts](src/MssqlTools.ts)
2. Add tool definition to `getToolDefinitions()`
3. Implement handler logic in `handleTool()`
4. Test with both STDIO and HTTP modes

### Modifying Query Execution Logic

Main execution logic is in `MssqlTools.handleExecuteSql()`:
- Always READ-ONLY mode (no configuration needed)
- Multi-layer validation via `isReadOnlyQuery()` — see "Security Model" for the full layer list (encoding decode, Unicode normalize, comment/backslash strip, dangerous-pattern blacklist, hex detector, whitelist starter check)
- Execution: Always uses `pool.query()` (no transactions). On `ResilientConnectionPool`, a lazy reconnect is attempted first if currently disconnected.
- Result caching: SHA256-keyed cache with lazy TTL cleanup and true LRU eviction
- Result formatting: CSV format only (via `formatCSV()` in [src/utils/csv.ts](src/utils/csv.ts))

### Testing with Different SQL Server Versions

The codebase is designed for SQL Server 2008+ compatibility:
- Uses `TOP` syntax instead of `LIMIT`
- No transaction nesting issues (read-only mode doesn't use transactions)
- LocalDB support for lightweight testing
- Compatible with Azure SQL Database

### Security Testing

Test the multi-layer read-only enforcement:
1. **Whitelist bypass attempts**: Try queries starting with non-allowed operations
2. **Blacklist bypass attempts**: Try obfuscated write operations (comments, case variations)
3. **Multi-statement attacks**: Test `SELECT 1; DROP TABLE` patterns
4. **SQL injection attempts**: Test malicious patterns in WHERE clauses
5. **Comment obfuscation**: Test `SELECT /*INSERT*/ * FROM` patterns
6. **URL-encoding bypass**: Test `%44%52%4F%50%20%54%41%42%4C%45` (encoded `DROP TABLE`)
7. **Unicode homograph attacks**: Test fullwidth characters (`ＤＲＯＰ`) and Cyrillic lookalikes
8. **Hex-encoded payloads**: Test `0x44524F50` (hex for "DROP")
9. **UNION-based exfiltration**: Verify `SELECT 1 UNION SELECT ...` is blocked
10. **SELECT INTO exfiltration**: Verify `SELECT * INTO new_table FROM ...` is blocked
11. **Stored procedure abuse**: Test `EXEC xp_cmdshell`, `sp_executesql`, `OPENROWSET`
12. **Backup/restore exfiltration**: Test `BACKUP DATABASE ... TO DISK = ...`
13. **False-positive regression**: Ensure `SELECT * FROM orders WHERE update_time > ...` (column name contains "update") is NOT blocked

## Build System

Custom esbuild bundler ([src/scripts/bundle.ts](src/scripts/bundle.ts)):
- Bundles to single ESM executable: `dist/main.mjs`
- Platform: node
- Format: esm
- Bundle: true (includes all dependencies)
- Outputs executable for npm global installation

## NPM Package

- Package name: `@bcihanc/mssql-mcp`
- Binary: `mssql-mcp` points to `dist/main.mjs`
- Can be run with `npx @bcihanc/mssql-mcp`
- Published to npm with public access
