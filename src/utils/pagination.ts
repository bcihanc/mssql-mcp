/**
 * Line-based pagination utilities for large text responses (procedure/view/function/trigger
 * definitions). Avoids token blow-up when AI requests definitions of multi-thousand-line
 * stored procedures.
 *
 * Why line-based (not byte-based)?
 *   - SQL definitions are line-oriented (line numbers in error messages, code review patterns)
 *   - Multi-byte UTF-8 characters break naive byte slicing mid-character
 *   - AI reasons about code in line ranges (e.g. "show me lines 50-100")
 */

export const DEFINITION_DEFAULT_LINES = parseInt(process.env.MSSQL_DEFINITION_DEFAULT_LINES || '200', 10);
export const DEFINITION_MAX_LINES = parseInt(process.env.MSSQL_DEFINITION_MAX_LINES || '1000', 10);

export interface PaginationParams {
	offset_lines?: number;
	max_lines?: number;
}

export interface PaginatedDefinition {
	content: string;
	total_lines: number;
	offset: number;
	returned_lines: number;
	has_more: boolean;
	next_offset?: number;
}

/**
 * Slice a multi-line text by line range.
 *
 * Behavior:
 *   - offset_lines defaults to 0; max_lines defaults to DEFINITION_DEFAULT_LINES (200)
 *   - max_lines is hard-capped at DEFINITION_MAX_LINES (1000) to prevent DoS
 *   - Negative or NaN inputs are normalized (offset → 0, max → default)
 *   - If offset >= total, returns empty content with has_more=false
 */
export function paginateLines(fullText: string, params: PaginationParams = {}): PaginatedDefinition {
	const lines = fullText.split('\n');
	const total = lines.length;

	let offset = Math.max(0, Math.floor(Number(params.offset_lines) || 0));
	let max = Math.floor(Number(params.max_lines) || DEFINITION_DEFAULT_LINES);
	if (!Number.isFinite(max) || max <= 0) max = DEFINITION_DEFAULT_LINES;
	if (max > DEFINITION_MAX_LINES) max = DEFINITION_MAX_LINES;

	if (offset >= total) {
		return {
			content: '',
			total_lines: total,
			offset,
			returned_lines: 0,
			has_more: false,
		};
	}

	const slice = lines.slice(offset, offset + max);
	const returned = slice.length;
	const hasMore = offset + returned < total;

	return {
		content: slice.join('\n'),
		total_lines: total,
		offset,
		returned_lines: returned,
		has_more: hasMore,
		next_offset: hasMore ? offset + returned : undefined,
	};
}

/**
 * Format a paginated definition as an MCP tool response with header metadata.
 *
 * Header format (single line, AI-parseable):
 *   📄 {objectName} — lines {start}-{end} of {total} | has_more={true|false}[ next_offset={n}]
 *
 * The header lets the AI see at a glance whether to paginate further. The body
 * is the raw definition text (no code fence — keeps token usage minimal and
 * lets the consumer wrap it themselves if needed).
 *
 * Empty-slice case (offset past end) returns a friendly explanation instead of
 * the header to make the misuse obvious.
 */
export function formatPaginatedResponse(paginated: PaginatedDefinition, objectName: string): string {
	if (paginated.returned_lines === 0) {
		if (paginated.total_lines === 0) {
			return `📄 ${objectName} — definition is empty.`;
		}
		return `📄 ${objectName} — offset_lines=${paginated.offset} is past end of definition (total_lines=${paginated.total_lines}).`;
	}

	const start = paginated.offset + 1;
	const end = paginated.offset + paginated.returned_lines;
	const nextHint = paginated.has_more ? ` next_offset=${paginated.next_offset}` : '';
	const header = `📄 ${objectName} — lines ${start}-${end} of ${paginated.total_lines} | has_more=${paginated.has_more}${nextHint}`;

	return `${header}\n${paginated.content}`;
}
