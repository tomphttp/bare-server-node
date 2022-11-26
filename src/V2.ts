import type { Request } from './AbstractMessage.js';
import { Response } from './AbstractMessage.js';
import { BareError } from './BareServer.js';
import type { ServerConfig } from './BareServer.js';
import type Server from './BareServer.js';
import {
	flattenHeader,
	mapHeadersFromArray,
	rawHeaderNames,
} from './headerUtil.js';
import type { BareHeaders, BareRemote } from './requestUtil.js';
import { fetch, upgradeFetch } from './requestUtil.js';
import { joinHeaders, splitHeaders } from './splitHeaderUtil.js';
import { Headers } from 'headers-polyfill';
import { randomBytes } from 'node:crypto';
import type {
	IncomingMessage,
	ServerResponse,
	Agent as HttpAgent,
} from 'node:http';
import type { Agent as HttpsAgent } from 'node:https';
import type { Duplex } from 'node:stream';
import { promisify } from 'node:util';

const validProtocols: string[] = ['http:', 'https:', 'ws:', 'wss:'];

const forbiddenForwardHeaders: string[] = [
	'connection',
	'transfer-encoding',
	'host',
	'connection',
	'origin',
	'referer',
];

const forbiddenPassHeaders: string[] = [
	'vary',
	'connection',
	'transfer-encoding',
	'access-control-allow-headers',
	'access-control-allow-methods',
	'access-control-expose-headers',
	'access-control-max-age',
	'access-control-request-headers',
	'access-control-request-method',
];

// common defaults
const defaultForwardHeaders: string[] = [
	'accept-encoding',
	'accept-language',
	'sec-websocket-extensions',
	'sec-websocket-key',
	'sec-websocket-version',
];

const defaultPassHeaders: string[] = [
	'content-encoding',
	'content-length',
	'last-modified',
];

// defaults if the client provides a cache key
const defaultCacheForwardHeaders: string[] = [
	'if-modified-since',
	'if-none-match',
	'cache-control',
];

const defaultCachePassHeaders: string[] = ['cache-control', 'etag'];

const cacheNotModified = 304;

const randomBytesAsync = promisify(randomBytes);

function loadForwardedHeaders(
	forward: string[],
	target: BareHeaders,
	request: Request
) {
	for (const header of forward) {
		if (request.headers.has(header)) {
			target[header] = request.headers.get(header)!;
		}
	}
}

const splitHeaderValue = /,\s*/g;

interface BareHeaderData {
	remote: BareRemote;
	sendHeaders: BareHeaders;
	passHeaders: string[];
	passStatus: number[];
	forwardHeaders: string[];
}

function readHeaders(request: Request): BareHeaderData {
	const remote = Object.setPrototypeOf({}, null);
	const sendHeaders = Object.setPrototypeOf({}, null);
	const passHeaders = [...defaultPassHeaders];
	const passStatus = [];
	const forwardHeaders = [...defaultForwardHeaders];

	// should be unique
	const cache = request.url.searchParams.has('cache');

	if (cache) {
		passHeaders.push(...defaultCachePassHeaders);
		passStatus.push(cacheNotModified);
		forwardHeaders.push(...defaultCacheForwardHeaders);
	}

	const headers = joinHeaders(request.headers);

	for (const remoteProp of ['host', 'port', 'protocol', 'path']) {
		const header = `x-bare-${remoteProp}`;

		if (headers.has(header)) {
			const value = headers.get(header)!;

			switch (remoteProp) {
				case 'port':
					if (isNaN(parseInt(value))) {
						throw new BareError(400, {
							code: 'INVALID_BARE_HEADER',
							id: `request.headers.${header}`,
							message: `Header was not a valid integer.`,
						});
					}
					break;
				case 'protocol':
					if (!validProtocols.includes(value)) {
						throw new BareError(400, {
							code: 'INVALID_BARE_HEADER',
							id: `request.headers.${header}`,
							message: `Header was invalid`,
						});
					}
					break;
			}

			remote[remoteProp] = value;
		} else {
			throw new BareError(400, {
				code: 'MISSING_BARE_HEADER',
				id: `request.headers.${header}`,
				message: `Header was not specified.`,
			});
		}
	}

	if (headers.has('x-bare-headers')) {
		try {
			const json = JSON.parse(headers.get('x-bare-headers')!);

			for (const header in json) {
				const value = json[header];

				if (typeof value === 'string') {
					sendHeaders[header] = value;
				} else if (Array.isArray(value)) {
					const array = [];

					for (const val in value) {
						if (typeof val !== 'string') {
							throw new BareError(400, {
								code: 'INVALID_BARE_HEADER',
								id: `bare.headers.${header}`,
								message: `Header was not a String.`,
							});
						}

						array.push(val);
					}

					sendHeaders[header] = array;
				} else {
					throw new BareError(400, {
						code: 'INVALID_BARE_HEADER',
						id: `bare.headers.${header}`,
						message: `Header was not a String.`,
					});
				}
			}
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new BareError(400, {
					code: 'INVALID_BARE_HEADER',
					id: `request.headers.x-bare-headers`,
					message: `Header contained invalid JSON. (${error.message})`,
				});
			} else {
				throw error;
			}
		}
	} else {
		throw new BareError(400, {
			code: 'MISSING_BARE_HEADER',
			id: `request.headers.x-bare-headers`,
			message: `Header was not specified.`,
		});
	}

	if (headers.has('x-bare-pass-status')) {
		const parsed = headers.get('x-bare-pass-status')!.split(splitHeaderValue);

		for (const value of parsed) {
			const number = parseInt(value);

			if (isNaN(number)) {
				throw new BareError(400, {
					code: 'INVALID_BARE_HEADER',
					id: `request.headers.x-bare-pass-status`,
					message: `Array contained non-number value.`,
				});
			} else {
				passStatus.push(number);
			}
		}
	}

	if (headers.has('x-bare-pass-headers')) {
		const parsed = headers.get('x-bare-pass-headers')!.split(splitHeaderValue);

		for (let header of parsed) {
			header = header.toLowerCase();

			if (forbiddenPassHeaders.includes(header)) {
				throw new BareError(400, {
					code: 'FORBIDDEN_BARE_HEADER',
					id: `request.headers.x-bare-forward-headers`,
					message: `A forbidden header was passed.`,
				});
			} else {
				passHeaders.push(header);
			}
		}
	}

	if (headers.has('x-bare-forward-headers')) {
		const parsed = headers
			.get('x-bare-forward-headers')!
			.split(splitHeaderValue);

		for (let header of parsed) {
			header = header.toLowerCase();

			if (forbiddenForwardHeaders.includes(header)) {
				throw new BareError(400, {
					code: 'FORBIDDEN_BARE_HEADER',
					id: `request.headers.x-bare-forward-headers`,
					message: `A forbidden header was forwarded.`,
				});
			} else {
				forwardHeaders.push(header);
			}
		}
	}

	return {
		remote,
		sendHeaders,
		passHeaders,
		passStatus,
		forwardHeaders,
	};
}

async function tunnelRequest(
	request: Request,
	res: ServerResponse<IncomingMessage>,
	serverConfig: ServerConfig,
	httpAgent: HttpAgent,
	httpsAgent: HttpsAgent
): Promise<Response> {
	const abort = new AbortController();

	request.body.on('close', () => {
		if (!request.body.complete) abort.abort();
	});

	res.on('close', () => {
		abort.abort();
	});

	const { remote, sendHeaders, passHeaders, passStatus, forwardHeaders } =
		readHeaders(request);

	loadForwardedHeaders(forwardHeaders, sendHeaders, request);

	const response = await fetch(
		request,
		abort.signal,
		sendHeaders,
		remote,
		serverConfig,
		httpAgent,
		httpsAgent
	);

	const responseHeaders = new Headers();

	for (const header of passHeaders) {
		if (!(header in response.headers)) continue;
		responseHeaders.set(header, flattenHeader(response.headers[header]!));
	}

	const status = passStatus.includes(response.statusCode!)
		? response.statusCode!
		: 200;

	if (status !== cacheNotModified) {
		responseHeaders.set('x-bare-status', response.statusCode!.toString());
		responseHeaders.set('x-bare-status-text', response.statusMessage!);
		responseHeaders.set(
			'x-bare-headers',
			JSON.stringify(
				mapHeadersFromArray(rawHeaderNames(response.rawHeaders), {
					...(<BareHeaders>response.headers),
				})
			)
		);
	}

	return new Response(response, {
		status,
		headers: splitHeaders(responseHeaders),
	});
}

interface Meta {
	response?: { status: number; statusText: string; headers: BareHeaders };
	set: number;
	sendHeaders: BareHeaders;
	remote: BareRemote;
	forwardHeaders: string[];
}

const tempMeta: Map<string, Meta> = new Map();

const metaExpiration = 30e3;

async function getMeta(request: Request): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(undefined, { status: 200 });
	}

	if (!request.headers.has('x-bare-id')) {
		throw new BareError(400, {
			code: 'MISSING_BARE_HEADER',
			id: 'request.headers.x-bare-id',
			message: 'Header was not specified',
		});
	}

	const id = request.headers.get('x-bare-id')!;

	if (!tempMeta.has(id)) {
		throw new BareError(400, {
			code: 'INVALID_BARE_HEADER',
			id: 'request.headers.x-bare-id',
			message: 'Unregistered ID',
		});
	}

	const meta = tempMeta.get(id)!;

	if (!meta.response) {
		throw new BareError(400, {
			code: 'INVALID_BARE_HEADER',
			id: 'request.headers.x-bare-id',
			message: 'Meta not ready',
		});
	}

	tempMeta.delete(id);

	const responseHeaders = new Headers();

	responseHeaders.set('x-bare-status', meta.response.status.toString());
	responseHeaders.set('x-bare-status-text', meta.response.statusText);
	responseHeaders.set('x-bare-headers', JSON.stringify(meta.response.headers));

	return new Response(undefined, {
		status: 200,
		headers: splitHeaders(responseHeaders),
	});
}

async function newMeta(request: Request): Promise<Response> {
	const { remote, sendHeaders, forwardHeaders } = readHeaders(request);

	const id = (await randomBytesAsync(32)).toString('hex');

	tempMeta.set(id, {
		set: Date.now(),
		remote,
		sendHeaders,
		forwardHeaders,
	});

	return new Response(Buffer.from(id));
}

async function tunnelSocket(
	request: Request,
	socket: Duplex,
	head: Buffer,
	serverConfig: ServerConfig,
	httpAgent: HttpAgent,
	httpsAgent: HttpsAgent
) {
	const abort = new AbortController();

	request.body.on('close', () => {
		if (!request.body.complete) abort.abort();
	});

	socket.on('close', () => {
		abort.abort();
	});

	if (!request.headers.has('sec-websocket-protocol')) {
		socket.end();
		return;
	}

	const id = request.headers.get('sec-websocket-protocol')!;

	if (!tempMeta.has(id)) {
		socket.end();
		return;
	}

	const meta = tempMeta.get(id)!;

	loadForwardedHeaders(meta.forwardHeaders, meta.sendHeaders, request);

	const [remoteResponse, remoteSocket] = await upgradeFetch(
		request,
		abort.signal,
		meta.sendHeaders,
		meta.remote,
		serverConfig,
		httpAgent,
		httpsAgent
	);

	remoteSocket.on('close', () => {
		socket.end();
	});

	socket.on('close', () => {
		remoteSocket.end();
	});

	remoteSocket.on('error', (error) => {
		if (serverConfig.logErrors) {
			console.error('Remote socket error:', error);
		}

		socket.end();
	});

	socket.on('error', (error) => {
		if (serverConfig.logErrors) {
			console.error('Serving socket error:', error);
		}

		remoteSocket.end();
	});

	const remoteHeaders = new Headers(<HeadersInit>remoteResponse.headers);

	meta.response = {
		headers: mapHeadersFromArray(rawHeaderNames(remoteResponse.rawHeaders), {
			...(<BareHeaders>remoteResponse.headers),
		}),
		status: remoteResponse.statusCode!,
		statusText: remoteResponse.statusMessage!,
	};

	const responseHeaders = [
		`HTTP/1.1 101 Switching Protocols`,
		`Upgrade: websocket`,
		`Connection: Upgrade`,
		`Sec-WebSocket-Protocol: ${id}`,
	];

	if (remoteHeaders.has('sec-websocket-extensions')) {
		responseHeaders.push(
			`Sec-WebSocket-Extensions: ${remoteHeaders.get(
				'sec-websocket-extensions'
			)}`
		);
	}

	if (remoteHeaders.has('sec-websocket-accept')) {
		responseHeaders.push(
			`Sec-WebSocket-Accept: ${remoteHeaders.get('sec-websocket-accept')}`
		);
	}

	socket.write(responseHeaders.concat('', '').join('\r\n'));

	remoteSocket.pipe(socket);
	socket.pipe(remoteSocket);
}

export default function registerV2(server: Server) {
	server.routes.set('/v2/', tunnelRequest);
	server.routes.set('/v2/ws-new-meta', newMeta);
	server.routes.set('/v2/ws-meta', getMeta);
	server.socketRoutes.set('/v2/', tunnelSocket);

	const interval = setInterval(() => {
		for (const [id, meta] of tempMeta) {
			const expires = meta.set + metaExpiration;

			if (expires < Date.now()) {
				tempMeta.delete(id);
			}
		}
	}, 1e3);

	server.once('close', () => {
		clearInterval(interval);
	});
}
