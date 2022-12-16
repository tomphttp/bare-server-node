import type { Request } from './AbstractMessage.js';
import { Response } from './AbstractMessage.js';
import type { RouteCallback, SocketRouteCallback } from './BareServer.js';
import type Server from './BareServer.js';
import { BareError, json } from './BareServer.js';
import { decodeProtocol } from './encodeProtocol.js';
import {
	flattenHeader,
	mapHeadersFromArray,
	rawHeaderNames,
} from './headerUtil.js';
import type { BareHeaders, BareRemote } from './requestUtil.js';
import { fetch, upgradeFetch, randomHex } from './requestUtil.js';
import { Headers } from 'headers-polyfill';

const validProtocols: string[] = ['http:', 'https:', 'ws:', 'wss:'];

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

interface BareHeaderData {
	remote: BareRemote;
	headers: BareHeaders;
}

function readHeaders(request: Request): BareHeaderData {
	const remote: Partial<BareRemote> & { [key: string]: string | number } = {};
	const headers: BareHeaders = {};
	Reflect.setPrototypeOf(headers, null);

	for (const remoteProp of ['host', 'port', 'protocol', 'path']) {
		const header = `x-bare-${remoteProp}`;

		if (request.headers.has(header)) {
			const value = request.headers.get(header)!;

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

	if (request.headers.has('x-bare-headers')) {
		try {
			const json = JSON.parse(request.headers.get('x-bare-headers')!) as Record<
				string,
				string | string[]
			>;

			for (const header in json) {
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
	} else {
		throw new BareError(400, {
			code: 'MISSING_BARE_HEADER',
			id: `request.headers.x-bare-headers`,
			message: `Header was not specified.`,
		});
	}

	if (request.headers.has('x-bare-forward-headers')) {
		let json;

		try {
			json = JSON.parse(request.headers.get('x-bare-forward-headers')!);
		} catch (error) {
			throw new BareError(400, {
				code: 'INVALID_BARE_HEADER',
				id: `request.headers.x-bare-forward-headers`,
				message: `Header contained invalid JSON. (${
					error instanceof Error ? error.message : error
				})`,
			});
		}

		loadForwardedHeaders(json, headers, request);
	} else {
		throw new BareError(400, {
			code: 'MISSING_BARE_HEADER',
			id: `request.headers.x-bare-forward-headers`,
			message: `Header was not specified.`,
		});
	}

	return { remote: <BareRemote>remote, headers };
}

const tunnelRequest: RouteCallback = async (request, res, options) => {
	const abort = new AbortController();

	request.body.on('close', () => {
		if (!request.body.complete) abort.abort();
	});

	res.on('close', () => {
		abort.abort();
	});

	const { remote, headers } = readHeaders(request);

	const response = await fetch(request, abort.signal, headers, remote, options);

	const responseHeaders = new Headers();

	for (const header in response.headers) {
		if (header === 'content-encoding' || header === 'x-content-encoding')
			responseHeaders.set(
				'content-encoding',
				flattenHeader(response.headers[header]!)
			);
		else if (header === 'content-length')
			responseHeaders.set(
				'content-length',
				flattenHeader(response.headers[header]!)
			);
	}

	responseHeaders.set(
		'x-bare-headers',
		JSON.stringify(
			mapHeadersFromArray(rawHeaderNames(response.rawHeaders), {
				...(<BareHeaders>response.headers),
			})
		)
	);

	responseHeaders.set('x-bare-status', response.statusCode!.toString());
	responseHeaders.set('x-bare-status-text', response.statusMessage!);

	return new Response(response, { status: 200, headers: responseHeaders });
};

const metaExpiration = 30e3;

const wsMeta: RouteCallback = async (request, res, options) => {
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
	});
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
	options
) => {
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
	} = JSON.parse(decodeProtocol(data));

	loadForwardedHeaders(forwardHeaders, headers, request);

	const [remoteResponse, remoteSocket] = await upgradeFetch(
		request,
		abort.signal,
		headers,
		remote,
		options
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

	const meta = await options.database.get(id);

	if (meta?.value.v === 1) {
		meta.value.response = {
			headers: mapHeadersFromArray(rawHeaderNames(remoteResponse.rawHeaders), {
				...(<BareHeaders>remoteResponse.headers),
			}),
		};
		await options.database.set(id, meta);
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
			`Sec-WebSocket-Extensions: ${remoteResponse.headers['sec-websocket-extensions']}`
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
}
