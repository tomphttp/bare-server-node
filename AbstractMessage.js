import { OutgoingMessage } from 'node:http';
import Stream from 'node:stream';
import { Headers } from 'fetch-headers';
export { Headers };
// from 'fetch-headers';

export class Request {
	constructor(body, method, path, headers) {
		this.body = body;
		this.method = method;
		this.headers = new Headers(headers);
		this.url = new URL(`http:${headers.host}${path}`);
	}
	get query() {
		return this.url.searchParams;
	}
}

export class Response {
	constructor(body, status, headers) {
		this.body = body;

		if (typeof status === 'number') {
			this.status = status;
		} else {
			this.status = 200;
		}

		this.headers = new Headers(headers);
	}
	send(response) {
		if (!(response instanceof OutgoingMessage))
			throw new TypeError('Request must be an OutgoingMessage');

		for (let [header, value] of this.headers) {
			response.setHeader(header, value);
		}

		response.writeHead(this.status);

		if (this.body instanceof Stream) {
			this.body.pipe(response);
		} else if (this.body instanceof Buffer) {
			response.write(this.body);
			response.end();
		} else {
			response.end();
		}

		return true;
	}
}
