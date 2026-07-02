import { z } from 'zod/v4';

/**
 * Shared Zod fragment merged into every tool's input schema so the AI can
 * discover the optional `connection_name` parameter on each tool. Omit it to
 * target the default connection.
 */
export const ConnectionScopeSchema = z.object({
	connection_name: z
		.string()
		.optional()
		.describe('Target connection name. Omit to use the default connection. Use list_connections to see available names.'),
});
