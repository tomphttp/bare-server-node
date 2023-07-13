import type { IncomingMessage, ServerResponse } from 'node:http';
import { Stream } from 'node:stream';
import type { BareHeaders } from './requestUtil.js';

export interface RequestInit {
	method: string;
	path: string;
	headers: Headers | BareHeaders;
}

/**
 * Abstraction for the data read from IncomingMessage
 */
export class Request {
	body: IncomingMessage;
	method: string;
	headers: Headers;
	url: URL;
	constructor(body: IncomingMessage, init: RequestInit) {
		this.body = body;
		this.method = init.method;
		this.headers = new Headers(init.headers as HeadersInit);
		// Parse the URL pathname. Host doesn't matter.
		this.url = new URL(init.path, 'http://bare-server-node');
	}
}

export type ResponseBody = Buffer | IncomingMessage;

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

		this.headers = new Headers(init.headers as HeadersInit);
	}
}

export function writeResponse(
	response: Response,
	res: ServerResponse
): boolean {
	for (const [header, value] of response.headers) res.setHeader(header, value);

	res.writeHead(response.status, response.statusText);

	if (response.body instanceof Stream) {
		const { body } = response;
		res.on('close', () => body.destroy());
		body.pipe(res);
	} else if (response.body instanceof Buffer) res.end(response.body);
	else res.end();

	return true;
}
