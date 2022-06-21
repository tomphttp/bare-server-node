import Stream from 'node:stream';
import { Headers } from 'fetch-headers';

/**
 * Abstraction for the data written to an IncomingMessage
 * @property {Stream} body
 * @property {string} method
 * @property {Headers} passHeaders
 * @property {URL} url
 */
export class Request {
	/**
	 *
	 * @param {Stream} body
	 * @param {{method:string, path: string, headers: Headers|import('./Server.js').BareHeaders}} [param1]
	 */
	constructor(body, { method, path, headers } = {}) {
		this.body = body;
		this.method = method;
		this.headers = new Headers(headers);
		this.url = new URL(`http:${headers.host}${path}`);
	}
	get query() {
		return this.url.searchParams;
	}
}

/**
 * @typedef {Buffer|Stream} ResponseBody
 */

/**
 * @typedef {object} ResponseInit
 * @property {Headers|import('./Server.js').BareHeaders} [headers]
 * @property {number} [status]
 * @property {string} [statusText]
 */

export class Response {
	/**
	 *
	 * @param {ResponseBody|undefined} body
	 * @param {ResponseInit} [init]
	 */
	constructor(body, init = {}) {
		if (body) {
			/**
			 * @type {ResponseBody|undefined}
			 */
			this.body = body instanceof Stream ? body : Buffer.from(body);
		}

		if (typeof init.status === 'number') {
			/**
			 * @type {number}
			 */
			this.status = init.status;
		} else {
			this.status = 200;
		}

		if (typeof init.statusText === 'string') {
			/**
			 * @type {string|undefined}
			 */
			this.statusText = init.statusText;
		}

		this.headers = new Headers(init.headers);
	}
}

/**
 *
 * @param {Response} response
 * @param {import('http').OutgoingMessage} res
 * @returns {boolean} Success
 */
export function writeResponse(response, res) {
	for (const [header, value] of response.headers) {
		res.setHeader(header, value);
	}

	res.writeHead(response.status, response.statusText);

	if (response.body instanceof Stream) {
		response.body.pipe(res);
	} else if (response.body instanceof Buffer) {
		res.write(response.body);
		res.end();
	} else {
		res.end();
	}

	return true;
}
