import { Readable } from 'node:stream';
import type {
	BareRequest,
	RouteCallback,
	SocketRouteCallback,
} from './BareServer.js';
import type Server from './BareServer.js';
import { BareError, json } from './BareServer.js';
import { decodeProtocol } from './encodeProtocol.js';
import {
	flattenHeader,
	mapHeadersFromArray,
	rawHeaderNames,
} from './headerUtil.js';
import type { BareRemote } from './remoteUtil.js';
import { remoteToURL } from './remoteUtil.js';
import type { BareHeaders } from './requestUtil.js';
import { bareFetch, bareUpgradeFetch, randomHex } from './requestUtil.js';
import type { BareV1Meta, BareV1MetaRes } from './V1Types.js';

const forbiddenSendHeaders = [
	'connection',
	'content-length',
	'transfer-encoding',
];

const forbiddenForwardHeaders: string[] = [
	'connection',
	'transfer-encoding',
	'origin',
	'referer',
];

const validProtocols: string[] = ['http:', 'https:', 'ws:', 'wss:'];

function loadForwardedHeaders(
	forward: string[],
	target: BareHeaders,
	request: BareRequest,
) {
	for (const header of forward) {
		const value = request.headers.get(header);
		if (value !== null) target[header] = value;
	}
}

interface BareHeaderData {
	remote: URL;
	headers: BareHeaders;
}

function readHeaders(request: BareRequest): BareHeaderData {
	const remote: Partial<BareRemote> & { [key: string]: string | number } =
		Object.create(null);
	const headers: BareHeaders = Object.create(null);

	for (const remoteProp of ['host', 'port', 'protocol', 'path']) {
		const header = `x-bare-${remoteProp}`;
		const value = request.headers.get(header)!;

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

	const xBareHeaders = request.headers.get('x-bare-headers');

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
				headers[header] = value;
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

				headers[header] = array;
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

	const xBareForwardHeaders = request.headers.get('x-bare-forward-headers');

	if (xBareForwardHeaders === null)
		throw new BareError(400, {
			code: 'MISSING_BARE_HEADER',
			id: `request.headers.x-bare-forward-headers`,
			message: `Header was not specified.`,
		});

	try {
		const parsed = JSON.parse(xBareForwardHeaders);
		const forwardHeaders: string[] = [];

		for (let header of parsed) {
			header = header.toLowerCase();

			// just ignore
			if (forbiddenForwardHeaders.includes(header)) continue;
			forwardHeaders.push(header);
		}

		loadForwardedHeaders(forwardHeaders, headers, request);
	} catch (error) {
		throw new BareError(400, {
			code: 'INVALID_BARE_HEADER',
			id: `request.headers.x-bare-forward-headers`,
			message: `Header contained invalid JSON. (${
				error instanceof Error ? error.message : error
			})`,
		});
	}

	return { remote: remoteToURL(remote as BareRemote), headers };
}

const tunnelRequest: RouteCallback = async (request, res, options) => {
	const abort = new AbortController();

	request.native.on('close', () => {
		if (!request.native.complete) abort.abort();
	});

	res.on('close', () => {
		abort.abort();
	});

	const { remote, headers } = readHeaders(request);

	const response = await bareFetch(
		request,
		abort.signal,
		headers,
		remote,
		options,
	);

	const responseHeaders = new Headers();

	for (const header in response.headers) {
		if (header === 'content-encoding' || header === 'x-content-encoding')
			responseHeaders.set(
				'content-encoding',
				flattenHeader(response.headers[header]!),
			);
		else if (header === 'content-length')
			responseHeaders.set(
				'content-length',
				flattenHeader(response.headers[header]!),
			);
	}

	responseHeaders.set(
		'x-bare-headers',
		JSON.stringify(
			mapHeadersFromArray(rawHeaderNames(response.rawHeaders), {
				...(<BareHeaders>response.headers),
			}),
		),
	);

	responseHeaders.set('x-bare-status', response.statusCode!.toString());
	responseHeaders.set('x-bare-status-text', response.statusMessage!);

	return new Response(Readable.toWeb(response), {
		status: 200,
		headers: responseHeaders,
	});
};

const metaExpiration = 30e3;

const wsMeta: RouteCallback = async (request, res, options) => {
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

	// check if meta isn't undefined and if the version equals 1
	if (meta?.value.v !== 1)
		throw new BareError(400, {
			code: 'INVALID_BARE_HEADER',
			id: 'request.headers.x-bare-id',
			message: 'Unregistered ID',
		});

	await options.database.delete(id);

	return json(200, {
		headers: meta.value.response?.headers,
	} as BareV1MetaRes);
};

const wsNewMeta: RouteCallback = async (request, res, options) => {
	const id = randomHex(16);

	await options.database.set(id, {
		value: { v: 1 },
		expires: Date.now() + metaExpiration,
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

	const [firstProtocol, data] = request.headers
		.get('sec-websocket-protocol')!
		.split(/,\s*/g);

	if (firstProtocol !== 'bare') {
		socket.end();
		return;
	}

	const {
		remote,
		headers,
		forward_headers: forwardHeaders,
		id,
	} = JSON.parse(decodeProtocol(data)) as BareV1Meta;

	loadForwardedHeaders(forwardHeaders, headers, request);

	const [remoteResponse, remoteSocket] = await bareUpgradeFetch(
		request,
		abort.signal,
		headers,
		remoteToURL(remote),
		options,
	);

	remoteSocket.on('close', () => {
		// console.log('Remote closed');
		socket.end();
	});

	socket.on('close', () => {
		// console.log('Serving closed');
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

	if (typeof id === 'string') {
		const meta = await options.database.get(id);

		if (meta?.value.v === 1) {
			meta.value.response = {
				headers: mapHeadersFromArray(
					rawHeaderNames(remoteResponse.rawHeaders),
					{
						...(<BareHeaders>remoteResponse.headers),
					},
				),
			};
			await options.database.set(id, meta);
		}
	}

	const responseHeaders = [
		`HTTP/1.1 101 Switching Protocols`,
		`Upgrade: websocket`,
		`Connection: Upgrade`,
		`Sec-WebSocket-Protocol: bare`,
		`Sec-WebSocket-Accept: ${remoteResponse.headers['sec-websocket-accept']}`,
	];

	if ('sec-websocket-extensions' in remoteResponse.headers) {
		responseHeaders.push(
			`Sec-WebSocket-Extensions: ${remoteResponse.headers['sec-websocket-extensions']}`,
		);
	}

	socket.write(responseHeaders.concat('', '').join('\r\n'));

	remoteSocket.pipe(socket);
	socket.pipe(remoteSocket);
};

export default function registerV1(server: Server) {
	server.routes.set('/v1/', tunnelRequest);
	server.routes.set('/v1/ws-new-meta', wsNewMeta);
	server.routes.set('/v1/ws-meta', wsMeta);
	server.socketRoutes.set('/v1/', tunnelSocket);
	server.versions.push('v1');
}
