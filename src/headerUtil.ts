import type { BareHeaders } from './requestUtil.js';

export function objectFromRawHeaders(raw: string[]): BareHeaders {
	const result: BareHeaders = Object.create(null);

	for (let i = 0; i < raw.length; i += 2) {
		const [header, value] = raw.slice(i, i + 2);
		if (header in result) {
			const v = result[header];
			if (Array.isArray(v)) v.push(value);
			else result[header] = [v, value];
		} else result[header] = value;
	}

	return result;
}

export function rawHeaderNames(raw: string[]) {
	const result: string[] = [];

	for (let i = 0; i < raw.length; i += 2) {
		if (!result.includes(raw[i])) result.push(raw[i]);
	}

	return result;
}

export function mapHeadersFromArray(from: string[], to: BareHeaders) {
	for (const header of from) {
		if (header.toLowerCase() in to) {
			const value = to[header.toLowerCase()];
			delete to[header.toLowerCase()];
			to[header] = value;
		}
	}

	return to;
}

/**
 * Converts a header into an HTTP-ready comma joined header.
 */
export function flattenHeader(value: string | string[]) {
	return Array.isArray(value) ? value.join(', ') : value;
}
