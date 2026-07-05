/**
 * Shared CSV formatting utilities for memory-efficient CSV generation
 */

/**
 * Format array of objects to CSV string
 * PERFORMANCE: Uses array join instead of string concatenation for O(n) instead of O(n²)
 *
 * @param results - Array of objects to format as CSV
 * @param warningMessage - Optional warning message to append
 * @param maxCellChars - Optional maximum characters per cell (truncates longer cells with marker)
 * @returns CSV formatted string
 */
export function formatCSV(results: any[], warningMessage?: string, maxCellChars?: number): string {
	if (!results || results.length === 0) {
		return '';
	}

	const columns = Object.keys(results[0]);
	const needsQuotingRegex = /[,"\n\r]/;

	// PERFORMANCE: Build array first, then join once (avoid repeated string concatenation)
	const lines: string[] = [columns.join(',')];

	for (const row of results) {
		const cells = columns.map((col) => {
			const value = row[col];
			if (value === null || value === undefined) return '';

			// PERFORMANCE: Single regex test instead of 3 includes() calls
			let strValue = String(value);
			// TOKEN EFFICIENCY: truncate very long cells BEFORE quoting so the marker stays readable
			if (maxCellChars && maxCellChars > 0 && strValue.length > maxCellChars) {
				strValue = `${strValue.slice(0, maxCellChars)}...[truncated ${strValue.length - maxCellChars} chars]`;
			}
			if (needsQuotingRegex.test(strValue)) {
				return `"${strValue.replace(/"/g, '""')}"`;
			}
			return strValue;
		});

		lines.push(cells.join(','));
	}

	let resultText = lines.join('\n');

	if (warningMessage) {
		resultText += warningMessage;
	}

	return resultText;
}

/**
 * Escape a single CSV cell value
 * @param value - Value to escape
 * @returns Escaped CSV cell value
 */
export function escapeCSVCell(value: any): string {
	if (value === null || value === undefined) return '';

	const strValue = String(value);
	const needsQuotingRegex = /[,"\n\r]/;

	if (needsQuotingRegex.test(strValue)) {
		return `"${strValue.replace(/"/g, '""')}"`;
	}

	return strValue;
}
