import { Readable } from 'node:stream';
import type {
	BareRequest,
	RouteCallback,
	SocketRouteCallback,
} from './BareServer.js';
import { BareError } from './BareServer.js';
import type Server from './BareServer.js';
import {
	flattenHeader,
	mapHeadersFromArray,
	rawHeaderNames,
} from './headerUtil.js';
import type { BareRemote } from './remoteUtil.js';
import { remoteToURL } from './remoteUtil.js';
import type { BareHeaders } from './requestUtil.js';
import {
	bareFetch,
	bareUpgradeFetch,
	nullBodyStatus,
	randomHex,
} from './requestUtil.js';
import { joinHeaders, splitHeaders } from './splitHeaderUtil.js';

const validProtocols: string[] = ['http:', 'https:', 'ws:', 'wss:'];

const forbiddenSendHeaders = [
	'connection',
	'content-length',
	'transfer-encoding',
];

const forbiddenForwardHeaders: string[] = [
	'connection',
	'transfer-encoding',
	'host',
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

function loadForwardedHeaders(
	forward: string[],
	target: BareHeaders,
	request: BareRequest,
) {
	for (const header of forward) {
		if (request.headers.has(header)) {
			target[header] = request.headers.get(header)!;
		}
	}
}

const splitHeaderValue = /,\s*/g;

interface BareHeaderData {
	remote: URL;
	sendHeaders: BareHeaders;
	passHeaders: string[];
	passStatus: number[];
	forwardHeaders: string[];
}

function readHeaders(request: BareRequest): BareHeaderData {
	const remote: Partial<BareRemote> & { [key: string]: string | number } =
		Object.create(null);
	const sendHeaders: BareHeaders = Object.create(null);
	const passHeaders = [...defaultPassHeaders];
	const passStatus = [];
	const forwardHeaders = [...defaultForwardHeaders];

	// should be unique
	const cache = new URL(request.url).searchParams.has('cache');

	if (cache) {
		passHeaders.push(...defaultCachePassHeaders);
		passStatus.push(cacheNotModified);
		forwardHeaders.push(...defaultCacheForwardHeaders);
	}

	const headers = joinHeaders(request.headers);

	for (const remoteProp of ['host', 'port', 'protocol', 'path']) {
		const header = `x-bare-${remoteProp}`;
		const value = headers.get(header);

		if (value === null)
			throw new BareError(400, {
				code: 'MISSING_BARE_HEADER',
				id: `request.headers.${header}`,
				message: `Header was not specified.`,
			});

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
	}

	const xBareHeaders = headers.get('x-bare-headers');

	if (xBareHeaders === null)
		throw new BareError(400, {
			code: 'MISSING_BARE_HEADER',
			id: `request.headers.x-bare-headers`,
			message: `Header was not specified.`,
		});

	try {
		const json = JSON.parse(xBareHeaders) as Record<string, string | string[]>;

		for (const header in json) {
			if (forbiddenSendHeaders.includes(header.toLowerCase())) continue;

			const value = json[header];

			if (typeof value === 'string') {
				sendHeaders[header] = value;
			} else if (Array.isArray(value)) {
				const array: string[] = [];

				for (const val of value) {
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
			} else
				throw new BareError(400, {
					code: 'INVALID_BARE_HEADER',
					id: `bare.headers.${header}`,
					message: `Header was not a String.`,
				});
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
		remote: remoteToURL(remote as BareRemote),
		sendHeaders,
		passHeaders,
		passStatus,
		forwardHeaders,
	};
}

const tunnelRequest: RouteCallback = async (request, res, options) => {
	const abort = new AbortController();

	request.native.on('close', () => {
		if (!request.native.complete) abort.abort();
	});

	res.on('close', () => {
		abort.abort();
	});

	const { remote, sendHeaders, passHeaders, passStatus, forwardHeaders } =
		readHeaders(request);

	loadForwardedHeaders(forwardHeaders, sendHeaders, request);

	const response = await bareFetch(
		request,
		abort.signal,
		sendHeaders,
		remote,
		options,
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
				}),
			),
		);
	}

	return new Response(
		nullBodyStatus.includes(status) ? undefined : Readable.toWeb(response),
		{
			status,
			headers: splitHeaders(responseHeaders),
		},
	);
};

const metaExpiration = 30e3;

const getMeta: RouteCallback = async (request, res, options) => {
	if (request.method === 'OPTIONS') {
		return new Response(undefined, { status: 200 });
	}

	const id = request.headers.get('x-bare-id');

	if (id === null)
		throw new BareError(400, {
			code: 'MISSING_BARE_HEADER',
			id: 'request.headers.x-bare-id',
			message: 'Header was not specified',
		});

	const meta = await options.database.get(id);

	if (meta?.value.v !== 2)
		throw new BareError(400, {
			code: 'INVALID_BARE_HEADER',
			id: 'request.headers.x-bare-id',
			message: 'Unregistered ID',
		});

	if (!meta.value.response)
		throw new BareError(400, {
			code: 'INVALID_BARE_HEADER',
			id: 'request.headers.x-bare-id',
			message: 'Meta not ready',
		});

	await options.database.delete(id);

	const responseHeaders = new Headers();

	responseHeaders.set('x-bare-status', meta.value.response.status.toString());
	responseHeaders.set('x-bare-status-text', meta.value.response.statusText);
	responseHeaders.set(
		'x-bare-headers',
		JSON.stringify(meta.value.response.headers),
	);

	return new Response(undefined, {
		status: 200,
		headers: splitHeaders(responseHeaders),
	});
};

const newMeta: RouteCallback = async (request, res, options) => {
	const { remote, sendHeaders, forwardHeaders } = readHeaders(request);

	const id = randomHex(16);

	await options.database.set(id, {
		expires: Date.now() + metaExpiration,
		value: {
			v: 2,
			remote: remote.toString(),
			sendHeaders,
			forwardHeaders,
		},
	});

	return new Response(Buffer.from(id));
};

const tunnelSocket: SocketRouteCallback = async (
	request,
	socket,
	head,
	options,
) => {
	const abort = new AbortController();

	request.native.on('close', () => {
		if (!request.native.complete) abort.abort();
	});

	socket.on('close', () => {
		abort.abort();
	});

	if (!request.headers.has('sec-websocket-protocol')) {
		socket.end();
		return;
	}

	const id = request.headers.get('sec-websocket-protocol')!;
	const meta = await options.database.get(id);

	if (meta?.value.v !== 2) {
		socket.end();
		return;
	}

	loadForwardedHeaders(
		meta.value.forwardHeaders,
		meta.value.sendHeaders,
		request,
	);

	const [remoteResponse, remoteSocket] = await bareUpgradeFetch(
		request,
		abort.signal,
		meta.value.sendHeaders,
		new URL(meta.value.remote),
		options,
	);

	remoteSocket.on('close', () => {
		socket.end();
	});

	socket.on('close', () => {
		remoteSocket.end();
	});

	remoteSocket.on('error', (error) => {
		if (options.logErrors) {
			console.error('Remote socket error:', error);
		}

		socket.end();
	});

	socket.on('error', (error) => {
		if (options.logErrors) {
			console.error('Serving socket error:', error);
		}

		remoteSocket.end();
	});

	const remoteHeaders = new Headers(remoteResponse.headers as HeadersInit);

	meta.value.response = {
		headers: mapHeadersFromArray(rawHeaderNames(remoteResponse.rawHeaders), {
			...(<BareHeaders>remoteResponse.headers),
		}),
		status: remoteResponse.statusCode!,
		statusText: remoteResponse.statusMessage!,
	};

	await options.database.set(id, meta);

	const responseHeaders = [
		`HTTP/1.1 101 Switching Protocols`,
		`Upgrade: websocket`,
		`Connection: Upgrade`,
		`Sec-WebSocket-Protocol: ${id}`,
	];

	if (remoteHeaders.has('sec-websocket-extensions')) {
		responseHeaders.push(
			`Sec-WebSocket-Extensions: ${remoteHeaders.get(
				'sec-websocket-extensions',
			)}`,
		);
	}

	if (remoteHeaders.has('sec-websocket-accept')) {
		responseHeaders.push(
			`Sec-WebSocket-Accept: ${remoteHeaders.get('sec-websocket-accept')}`,
		);
	}

	socket.write(responseHeaders.concat('', '').join('\r\n'));

	remoteSocket.pipe(socket);
	socket.pipe(remoteSocket);
};

export default function registerV2(server: Server) {
	server.routes.set('/v2/', tunnelRequest);
	server.routes.set('/v2/ws-new-meta', newMeta);
	server.routes.set('/v2/ws-meta', getMeta);
	server.socketRoutes.set('/v2/', tunnelSocket);
	server.versions.push('v2');
}
