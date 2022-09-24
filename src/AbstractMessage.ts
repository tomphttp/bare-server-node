import { BareHeaders } from './requestUtil.js';
import { Headers } from 'headers-polyfill';
import http from 'http';
import Stream from 'stream';

export interface RequestInit {
	method: string;
	path: string;
	headers: Headers | BareHeaders;
}

/**
 * Abstraction for the data read from IncomingMessage
 */
export class Request {
	body: Stream;
	method: string;
	headers: Headers;
	url: URL;
	constructor(body: Stream, init: RequestInit) {
		this.body = body;
		this.method = init.method;
		this.headers = new Headers(init.headers);
		this.url = new URL(`http:${this.headers.get('host')}${init.path}`);
	}
	get query() {
		return this.url.searchParams;
	}
}

export type ResponseBody = Buffer | Stream;

export interface ResponseInit {
	headers?: Headers | BareHeaders;
	status?: number;
	statusText?: string;
}

export class Response {
	body?: ResponseBody;
	status: number;
	statusText?: string;
	headers: Headers;
	constructor(body: ResponseBody | undefined, init: ResponseInit = {}) {
		if (body) {
			this.body = body instanceof Stream ? body : Buffer.from(body);
		}

		if (typeof init.status === 'number') {
			this.status = init.status;
		} else {
			this.status = 200;
		}

		if (typeof init.statusText === 'string') {
			this.statusText = init.statusText;
		}

		this.headers = new Headers(init.headers);
	}
}

export function writeResponse(
	response: Response,
	res: http.ServerResponse
): boolean {
	for (const [header, value] of response.headers) {
		res.setHeader(header, value);
	}

	res.writeHead(response.status, response.statusText);

	if (response.body instanceof Stream) {
		response.body.pipe(res);
	} else if (response.body instanceof Buffer) {
		res.end(response.body);
	} else {
		res.end();
	}

	return true;
}
