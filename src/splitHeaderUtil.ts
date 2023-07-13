import { BareError } from './BareServer.js';

const MAX_HEADER_VALUE = 3072;

/**
 *
 * Splits headers according to spec
 * @param headers
 * @returns Split headers
 */
export function splitHeaders(headers: Headers): Headers {
	const output = new Headers(headers);

	if (headers.has('x-bare-headers')) {
		const value = headers.get('x-bare-headers')!;

		if (value.length > MAX_HEADER_VALUE) {
			output.delete('x-bare-headers');

			let split = 0;

			for (let i = 0; i < value.length; i += MAX_HEADER_VALUE) {
				const part = value.slice(i, i + MAX_HEADER_VALUE);

				const id = split++;
				output.set(`x-bare-headers-${id}`, `;${part}`);
			}
		}
	}

	return output;
}

/**
 * Joins headers according to spec
 * @param headers
 * @returns Joined headers
 */
export function joinHeaders(headers: Headers): Headers {
	const output = new Headers(headers);

	const prefix = 'x-bare-headers';

	if (headers.has(`${prefix}-0`)) {
		const join: string[] = [];

		for (const [header, value] of headers) {
			if (!header.startsWith(prefix)) {
				continue;
			}

			if (!value.startsWith(';')) {
				throw new BareError(400, {
					code: 'INVALID_BARE_HEADER',
					id: `request.headers.${header}`,
					message: `Value didn't begin with semi-colon.`,
				});
			}

			const id = parseInt(header.slice(prefix.length + 1));

			join[id] = value.slice(1);

			output.delete(header);
		}

		output.set(prefix, join.join(''));
	}

	return output;
}
