# @bcihanc/mssql-mcp

A secure, **READ-ONLY** Microsoft SQL Server MCP (Model Context Protocol) server that enables Claude Desktop to safely query SQL Server databases through natural language.

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

## 🚀 Quick Start

### Install and Run with npx from GitHub

```bash
# Run directly from GitHub (no installation required)
npx -y github:bcihanc/mssql-mcp --help

# Start with environment variables
MSSQL_SERVER=localhost MSSQL_DATABASE=mydb MSSQL_USER=sa MSSQL_PASSWORD=password npx -y github:bcihanc/mssql-mcp --stdio

# Start with environment file (recommended)
npx -y github:bcihanc/mssql-mcp --env-file .env --stdio
```

### Clone and Run Locally

```bash
# Clone the repository
git clone https://github.com/bcihanc/mssql-mcp.git
cd mssql-mcp

# Install dependencies
npm install

# Build
npm run build

# Run
node dist/main.mjs --env-file .env --stdio
```

## ✨ Features

- 🛡️ **READ-ONLY by Design**: Multi-layer security prevents any data modification (no write operations possible)
- 🤖 **AI-Ready**: Seamless integration with Claude Desktop and MCP protocol
- 🔍 **Smart Queries**: Execute read-only SQL queries in CSV format through natural language
- 🔐 **Secure Authentication**: Support for SQL Server Auth, Windows Auth, and Azure SQL
- 🏢 **Enterprise Ready**: LocalDB, Azure SQL Database, and SQL Server 2008+ support
- 📊 **Data Access**: Browse database tables and their contents automatically
- 🚀 **Zero Config**: Single executable with all dependencies bundled
- 🔒 **Advanced Security**: Multi-layer protection with SHA256 cache, Unicode normalization, encoding bypass prevention, and comprehensive validation
- 📝 **Auto-Logging**: File-based debug logging enabled by default for easy troubleshooting (especially useful on Windows)

## 🏗️ Setup for Claude Desktop

### 1. Create Environment File

Create a `.env` file with your database credentials:

```bash
# Required: Database connection
MSSQL_SERVER=localhost
MSSQL_DATABASE=AdventureWorks2019
MSSQL_USER=sa
MSSQL_PASSWORD=YourPassword123

# Optional: Security and performance
MSSQL_ENCRYPT=false         # Set 'true' for Azure SQL (auto-enabled for *.database.windows.net)

# Note: This MCP server is READ-ONLY by design - no configuration needed for read-only mode
```

### 2. Configure Claude Desktop

#### macOS/Linux

Add to your `claude_desktop_config.json`:

**Option 1: Run from GitHub (Recommended)**
```json
{
  "mcpServers": {
    "mssql": {
      "command": "npx",
      "args": ["-y", "github:bcihanc/mssql-mcp", "--env-file", "/path/to/your/.env", "--stdio"]
    }
  }
}
```

**Option 2: Run from Local Clone**
```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": [
        "/path/to/mssql-mcp/dist/main.mjs",
        "--stdio",
        "--env-file",
        "/path/to/your/.env"
      ]
    }
  }
}
```

#### Windows

**Option 1: Run from GitHub (Recommended)**

```json
{
  "mcpServers": {
    "mssql": {
      "command": "npx",
      "args": ["-y", "github:bcihanc/mssql-mcp", "--env-file", "C:/path/to/your/.env", "--stdio"]
    }
  }
}
```

**Option 2: Run from Local Clone (Better STDIO compatibility)**

```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": [
        "C:/path/to/mssql-mcp/dist/main.mjs",
        "--stdio",
        "--env-file",
        "C:/path/to/your/.env"
      ]
    }
  }
}
```

**Windows Tips:**
- Use forward slashes (`/`) or double backslashes (`\\`) in paths
- Example: `C:/Users/YourName/.env` or `C:\\Users\\YourName\\.env`
- LocalDB connection string formats (all supported):
  - `MSSQL_SERVER=(localdb)\MSSQLLocalDB` (single backslash)
  - `MSSQL_SERVER=(localdb)\\MSSQLLocalDB` (double backslash)
  - Case-insensitive: `(LocalDB)\MSSQLLocalDB` works too
- Windows Authentication: Set `MSSQL_WINDOWS_AUTH=true` in .env file

**Windows Troubleshooting:**
- If MCP server doesn't connect: Try using `node` command directly (see recommended config above)
- Find your npm global path: `npm config get prefix`
- LocalDB not working: Run `sqllocaldb info` and `sqllocaldb start MSSQLLocalDB`
- Windows Auth failed: Ensure your Windows user has SQL Server access
- **Debug logs**: Automatically enabled! Check `logs/mssql-mcp-*.log` files
- For more details, see [CLAUDE.md](CLAUDE.md#windows-support) and [Debug Logging](CLAUDE.md#debug-logging)

### 3. Restart Claude Desktop

Your SQL Server database is now available to Claude! 🎉

## 📋 Environment Configuration

### SQL Server Authentication

```bash
MSSQL_SERVER=localhost
MSSQL_DATABASE=your_database
MSSQL_USER=your_username
MSSQL_PASSWORD=your_password
```

### Windows Authentication

```bash
MSSQL_SERVER=localhost
MSSQL_DATABASE=your_database
MSSQL_WINDOWS_AUTH=true
```

### Azure SQL Database

```bash
MSSQL_SERVER=yourserver.database.windows.net
MSSQL_DATABASE=your_database
MSSQL_USER=your_username
MSSQL_PASSWORD=your_password
# MSSQL_ENCRYPT=true (automatically enabled for Azure SQL)
```

### LocalDB

```bash
MSSQL_SERVER=(localdb)\\MSSQLLocalDB
MSSQL_DATABASE=MyLocalDatabase
MSSQL_WINDOWS_AUTH=true
```

### Advanced Options

```bash
# Connection Settings
MSSQL_PORT=1433                  # Port (default: 1433)
MSSQL_ENCRYPT=true               # Force encryption (default: false, auto-enabled for Azure SQL)

# Performance Tuning (Optional)
MSSQL_MAX_ROWS=10000             # Max rows per query (default: 10,000) - truncates with warning
MSSQL_WARN_ROWS=5000             # Warning threshold (default: 5,000) - warns but doesn't truncate
MSSQL_RESOURCE_LIMIT=100         # Rows for resource browsing (default: 100)

# Query Result Caching (exec_sql_csv)
MSSQL_CACHE_TTL=60000            # Query cache duration in ms (default: 60,000 = 60s)
MSSQL_CACHE_SIZE=100             # Max cached queries (default: 100)

# Tool-Specific Caching (for metadata operations)
# Database schema rarely changes, so longer TTLs provide better performance
MSSQL_TABLES_CACHE_TTL=1800000   # list_tables cache TTL (default: 1,800,000 = 30 min)
MSSQL_SCHEMA_CACHE_TTL=7200000   # get_table_schema cache TTL (default: 7,200,000 = 2 hours)
MSSQL_SCHEMA_CACHE_SIZE=200      # Max cached table schemas (default: 200)
MSSQL_FK_CACHE_TTL=14400000      # get_foreign_keys cache TTL (default: 14,400,000 = 4 hours)
MSSQL_FK_CACHE_SIZE=100          # Max cached FK queries (default: 100)
MSSQL_RELATIONSHIPS_CACHE_TTL=14400000  # get_table_relationships cache TTL (default: 14,400,000 = 4 hours)
MSSQL_RELATIONSHIPS_CACHE_SIZE=100      # Max cached relationship queries (default: 100)
MSSQL_COLUMNS_CACHE_TTL=7200000  # search_columns cache TTL (default: 7,200,000 = 2 hours)
MSSQL_COLUMNS_CACHE_SIZE=100     # Max cached column searches (default: 100)
MSSQL_INDEXES_CACHE_TTL=14400000 # get_table_indexes cache TTL (default: 14,400,000 = 4 hours)
MSSQL_INDEXES_CACHE_SIZE=200     # Max cached index queries (default: 200)
```

**Note**: `MSSQL_ACCESS_MODE` has been removed. This server is **always READ-ONLY** for security.

## 🛠️ Available Tools

When connected, Claude can use these capabilities:

### 📊 SQL Query Execution (READ-ONLY)

- **`exec_sql_csv`**: Execute **READ-ONLY** SQL queries and get results in CSV format
  - ✅ Allowed: SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, DESC
  - ❌ Blocked: INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, EXEC, GRANT, REVOKE, and all other write operations
- **`get_version`**: Get SQL Server version information

### 📂 Database Discovery & Schema

- **`list_tables`**: List all tables and views in the database with schema, type, row count, and size information
  - Optional filtering by schema name
  - Returns: Schema, Name, Type (BASE TABLE/VIEW), Row Count, Size in MB
  - Now includes both tables and views for complete database object discovery

- **`get_table_schema`**: Get detailed schema information for a specific table
  - Returns: Column names, data types, max length, nullability, default values
  - Constraint information: PRIMARY KEY, FOREIGN KEY, UNIQUE constraints
  - Computed column detection with expression definitions
  - Supports schema specification (default: "dbo")

- **`get_table_indexes`**: Get all indexes for a specific table (NEW - Essential for performance troubleshooting)
  - Returns: Index name, type (CLUSTERED/NONCLUSTERED), uniqueness, primary key status
  - Shows indexed columns with ordinal position and included columns
  - Perfect for analyzing query performance and identifying missing indexes
  - Supports schema specification (default: "dbo")

### 🔗 Relationship & Discovery Tools

- **`get_foreign_keys`**: Get all foreign key relationships in the database
  - Returns: Constraint name, parent/child tables, columns, cascade rules (ON DELETE, ON UPDATE)
  - Optional filtering by table name or schema
  - Helps understand data model and table dependencies

- **`search_columns`**: Search for columns by name across all tables
  - Supports partial matching with LIKE patterns (use % as wildcard)
  - Returns: Schema, table, column name, data type, max length, nullable status
  - Perfect for finding "email", "user_id", or any column across the entire database

- **`get_table_relationships`**: Get all parent and child relationships for a specific table
  - Shows both PARENT relationships (this table references others) and CHILD relationships (others reference this table)
  - Returns: Relationship type, related table, constraint name, column mappings
  - Ideal for understanding table dependencies before queries

### 📂 Database Resources

- **Table Discovery**: Automatically lists all available tables
- **Table Data Access**: Browse table contents (top 100 rows per table)
- **Schema Information**: Access table structures and metadata

## 🛡️ Security Features

### Multi-Layer READ-ONLY Protection

This MCP server is **READ-ONLY by design** with comprehensive security layers:

#### Query Validation Layers

1. **Layer 1 - Whitelist Validation**: Only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, DESC allowed
2. **Layer 2 - Blacklist Detection**: Blocks INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, GRANT, REVOKE, EXEC, UNION, xp_cmdshell, OPENROWSET, OPENQUERY, OPENDATASOURCE, BULK, BACKUP, RESTORE
3. **Layer 3 - Comment Stripping**: Removes SQL comments (line and block) before validation to prevent obfuscation
4. **Layer 4 - Multi-Statement Detection**: Prevents chained dangerous operations (e.g., `SELECT 1; DROP TABLE users`)
5. **Layer 5 - Runtime Detection**: Connection pool detects write operations in error messages and blocks them
6. **Layer 6 - Error Sanitization**: Enhanced error messages for write attempt detection

#### Advanced Encoding & Bypass Protection

7. **Unicode Normalization (NFKC)**: Converts lookalike Unicode characters to canonical forms to prevent homograph attacks
   - Example: `\u0053` (LATIN CAPITAL LETTER S) → `S`
   - Prevents bypass attempts like `\u0053ELECT * FROM users`

8. **URL Encoding Detection**: Automatically decodes URL-encoded queries before validation
   - Prevents bypass attempts like `%53ELECT` or `UN%49ON`
   - Catches obfuscation techniques using percent-encoding

9. **Hex Encoding Detection**: Identifies and blocks hexadecimal-encoded keywords
   - Blocks patterns like `0x44524F50` (hex for "DROP")
   - Prevents hex literal bypass attempts in queries

10. **Backslash Removal**: Strips backslashes used in encoding bypass attempts
    - Prevents techniques like `\x44\x52\x4F\x50` TABLE users

#### Cache Security

11. **SHA256 Hash-Based Cache Keys**: Prevents cache poisoning attacks
    - Uses cryptographic hashing instead of simple normalization
    - Ensures different queries always produce different cache keys
    - Eliminates collision risks from crafted malicious queries

### Allowed Operations

✅ **Safe read-only operations**:
- `SELECT` statements (basic queries, joins, subqueries)
- `WITH` (Common Table Expressions/CTEs)
- `SHOW`, `DESCRIBE`, `EXPLAIN`, `DESC` commands

⚠️ **Limited operations** (blocked for security):
- `UNION` queries - While technically read-only, UNION is commonly used in SQL injection attacks and is blocked as a security trade-off. Users can run multiple separate queries instead.

❌ **Blocked operations**:
- All write operations (INSERT, UPDATE, DELETE, MERGE)
- Schema changes (CREATE, ALTER, DROP, TRUNCATE)
- Security changes (GRANT, REVOKE, DENY)
- System commands (EXEC, xp_cmdshell, sp_executesql)
- External data access (OPENROWSET, OPENQUERY, OPENDATASOURCE)
- Backup/restore operations (BACKUP, RESTORE)
- Bulk operations (BULK INSERT)

### Additional Security

- ✅ SQL injection prevention through table name validation with regex (`^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)?$`)
- ✅ Table name bracket escaping (`[schema].[table]` format)
- ✅ Connection encryption for Azure SQL (auto-detected for `*.database.windows.net`)
- ✅ Secure credential handling (environment variables only, no hardcoded credentials)
- ✅ Comprehensive security test suite with 52 test cases (100% pass rate)
- ✅ No configuration required - always secure by default

### Security Testing

Run the comprehensive security test suite:

```bash
npm run test:security
```

The test suite validates protection against:
- 🔒 Write operation bypass attempts (31 tests)
- 🔒 Unicode and encoding bypasses (7 tests)
- 🔒 SQL injection attempts (6 tests)
- 🔒 Edge cases and obfuscation (8 tests)

**Total: 52 security tests with 100% pass rate**

## 🎯 Usage Examples

### Ask Claude to Query Your Database

> "Show me the top 10 customers by total sales from the database"

> "What tables are available in this database?"

> "Create a summary report of inventory levels by category"

> "Find all orders placed in the last 30 days"

### Explore Database Structure

> "Show me all foreign key relationships in the database"

> "Find all tables that have a column containing 'email'"

> "What are the parent and child relationships for the Orders table?"

> "Show me the schema of the Users table"

### Advanced Discovery

> "Which tables reference the Users table?"

> "Find all columns with 'date' in their name across all tables"

> "Show me the foreign keys for tables in the 'sales' schema"

Claude will automatically:
1. 🔍 Explore available tables and relationships
2. 📝 Write appropriate SQL queries
3. 📊 Execute queries and format results
4. 📈 Analyze and explain the data
5. 🔗 Identify table dependencies and connections

## 🚀 Command Line Usage

### STDIO Mode (Claude Desktop)

```bash
# From GitHub
npx -y github:bcihanc/mssql-mcp --stdio --env-file .env

# From local clone
node dist/main.mjs --stdio --env-file .env
```

### HTTP Mode (Development)

```bash
# From GitHub
npx -y github:bcihanc/mssql-mcp --port 3003 --host localhost --env-file .env

# From local clone
node dist/main.mjs --port 3003 --host localhost --env-file .env
```

### Command Options

- `--stdio`: Use STDIO transport (required for Claude Desktop)
- `--env-file <path>`: Load environment variables from file
- `--port <port>`: HTTP server port (default: 3003)
- `--host <host>`: HTTP server host (default: localhost)
- `--verbose`: Enable detailed logging
- `--help`: Show help information

## 🔧 Troubleshooting

### Connection Issues

```bash
# Test connection - from GitHub
npx -y github:bcihanc/mssql-mcp --verbose --env-file .env

# Test connection - from local clone
node dist/main.mjs --verbose --env-file .env

# Check SQL Server is running
sqlcmd -S localhost -U sa -P yourpassword -Q "SELECT @@VERSION"
```

### Common Problems

**"Login failed"**: Check username, password, and database name
**"Server not found"**: Verify `MSSQL_SERVER` and `MSSQL_PORT`
**"SSL error"**: Set `MSSQL_ENCRYPT=false` for local development
**"Permission denied"**: Ensure user has database access permissions

### Debug Mode

```bash
# Enable verbose logging - from GitHub
npx -y github:bcihanc/mssql-mcp --verbose --stdio --env-file .env

# Enable verbose logging - from local clone
node dist/main.mjs --verbose --stdio --env-file .env
```

## 📚 Example Databases

### AdventureWorks (Learning)

Perfect for testing and learning (always safe - read-only by default):

1. Download [AdventureWorks backup files](https://github.com/Microsoft/sql-server-samples/releases/tag/adventureworks)
2. Restore to your SQL Server instance
3. Configure connection:

```bash
MSSQL_SERVER=localhost
MSSQL_DATABASE=AdventureWorks2019
MSSQL_USER=sa
MSSQL_PASSWORD=YourPassword123
# No need for MSSQL_ACCESS_MODE - always read-only for safety
```

### Northwind (Classic)

Great for business scenarios:

```bash
MSSQL_SERVER=localhost
MSSQL_DATABASE=Northwind
MSSQL_USER=sa
MSSQL_PASSWORD=YourPassword123
```

## 🏢 Enterprise Features

- **SQL Server 2008+ Compatibility**: Works with legacy systems
- **Connection Pooling**: Automatic connection management
- **High Availability**: Supports SQL Server clusters and availability groups
- **Multi-Database**: Connect to different databases by changing configuration
- **Audit Trail**: All queries are logged for security compliance

## 📄 License

MIT License - feel free to use in personal and commercial projects.

## 🤝 Contributing

Issues and feature requests are welcome on [GitHub](https://github.com/bcihanc/mssql-mcp).

## 🔗 Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io/) - The protocol specification
- [Claude Desktop](https://claude.ai/download) - AI assistant with MCP support
- [Microsoft SQL Server](https://www.microsoft.com/sql-server/) - Database platform

---

**Made with ❤️ for the AI and SQL Server community**
