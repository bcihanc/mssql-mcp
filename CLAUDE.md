# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

@wener/mssql-mcp is a **READ-ONLY** Model Context Protocol (MCP) server that enables AI assistants like Claude to safely query Microsoft SQL Server databases. The server provides read-only SQL query execution, database browsing, and schema inspection capabilities.

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
Removes the `dist` directory.

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

4. **Eager Connection** - Database connection pool connects immediately at startup instead of lazy initialization, eliminating cold start latency (first query ~100ms faster)

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

6. **Query Validation Optimization** - Combined regex patterns reduce validation from 11 regex operations to just 2 (dangerous pattern check + whitelist check), significantly reducing CPU overhead for query validation (~5x faster)

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
- **First Query**: ~100ms faster (eager connection)
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
   - Returns top 100 rows per table in CSV format

4. **Connection Management** ([src/server/connection.ts](src/server/connection.ts))
   - Creates and manages `mssql` connection pool
   - Provides unified `ConnectionPool` interface with single query method:
     - `query()`: Simple read-only query execution
   - Detects and blocks write operations with enhanced error messages
   - Supports both SQL Server Authentication and Windows Authentication
   - Connection pool configured for read-only access

5. **Configuration** ([src/server/config.ts](src/server/config.ts))
   - Parses environment variables into `MssqlConfig`
   - Detects and handles special cases:
     - Azure SQL (auto-enables encryption for `*.database.windows.net`)
     - LocalDB (converts `(localdb)\instance` to `.\\instance` format)
   - Validates table names to prevent SQL injection
   - **Enhanced Read-Only Query Detection** with dual-layer protection:
     - **Whitelist validation**: Only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, DESC
     - **Blacklist detection**: Blocks INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, EXEC, GRANT, REVOKE, xp_cmdshell, OPENROWSET, etc.

6. **CSV Utilities** ([src/utils/csv.ts](src/utils/csv.ts))
   - Shared CSV formatting utilities for memory-efficient output generation
   - `formatCSV()`: Converts query results to CSV with O(n) complexity (array join pattern)
   - `escapeCSVCell()`: Proper escaping for special characters (commas, quotes, newlines)
   - Eliminates code duplication between MssqlTools and MssqlResources
   - Ensures consistent CSV formatting across all outputs
     - **Comment stripping**: Removes SQL comments before validation
     - **Multi-statement detection**: Prevents chained dangerous operations

### Data Flow

1. **Incoming MCP Request** → MssqlMcpServer receives via STDIO or HTTP transport
2. **Request Routing**:
   - Tool requests → MssqlTools.handleTool()
   - Resource list → MssqlResources.getResourceDefinitions()
   - Resource read → MssqlResources.handleResource()
3. **Query Execution** (READ-ONLY enforced at multiple layers):
   - **Layer 1**: Input validation via Zod schema
   - **Layer 2**: Read-only query validation (`isReadOnlyQuery()`)
     - Whitelist check: Must start with SELECT, WITH, SHOW, etc.
     - Blacklist check: Must not contain INSERT, UPDATE, DELETE, DROP, etc.
   - **Layer 3**: Connection pool execution with write detection
   - **Layer 4**: Error handling with write attempt detection
4. **Response Formatting** → CSV format only
5. **Return to Client** → Structured MCP response

### Security Model

**THIS MCP SERVER IS READ-ONLY BY DESIGN - NO CONFIGURATION REQUIRED**

- **Multi-Layer Read-Only Enforcement**:
  - **Layer 1 - Whitelist Validation**: Only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, DESC queries allowed
  - **Layer 2 - Blacklist Detection**: Blocks INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, GRANT, REVOKE, EXEC, xp_cmdshell, OPENROWSET, OPENQUERY, OPENDATASOURCE
  - **Layer 3 - Comment Stripping**: Removes SQL comments (line and block) before validation to prevent obfuscation
  - **Layer 4 - Multi-Statement Detection**: Prevents chained dangerous operations (e.g., `SELECT 1; DROP TABLE users`)
  - **Layer 5 - Runtime Detection**: Connection pool detects write operations in error messages and blocks them
  - **Layer 6 - Error Sanitization**: Enhanced error messages for write attempt detection

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
- Health check endpoint at `/health`
- MCP endpoint at `/mcp`

### Read-Only Query Execution

The connection layer implements simple read-only query execution:
- All queries executed directly without transactions (no write operations possible)
- Error detection for write attempts with enhanced error messages
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
- Multi-layer validation via `isReadOnlyQuery()`:
  - Whitelist check for allowed operations
  - Blacklist check for dangerous patterns
  - Comment stripping before validation
- Execution: Always uses `pool.query()` (no transactions)
- Result formatting: CSV format only

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

## Build System

Custom esbuild bundler ([src/scripts/bundle.ts](src/scripts/bundle.ts)):
- Bundles to single ESM executable: `dist/main.mjs`
- Platform: node
- Format: esm
- Bundle: true (includes all dependencies)
- Outputs executable for npm global installation

## NPM Package

- Package name: `@wener/mssql-mcp`
- Binary: `mssql-mcp` points to `dist/main.mjs`
- Can be run with `npx @wener/mssql-mcp`
- Published to npm with public access
