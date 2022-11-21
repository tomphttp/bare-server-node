import type { Request } from './AbstractMessage.js';
import { Response } from './AbstractMessage.js';
import type { ServerConfig } from './BareServer.js';
import type Server from './BareServer.js';
import { BareError, json } from './BareServer.js';
import { decodeProtocol } from './encodeProtocol.js';
import {
	flattenHeader,
	mapHeadersFromArray,
	rawHeaderNames,
} from './headerUtil.js';
import type { BareHeaders, BareRemote } from './requestUtil.js';
import { fetch, upgradeFetch } from './requestUtil.js';
import { Headers } from 'headers-polyfill';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { promisify } from 'node:util';

const validProtocols: string[] = ['http:', 'https:', 'ws:', 'wss:'];

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
			const json = JSON.parse(request.headers.get('x-bare-headers')!);

			for (const header in json) {
				if (typeof json[header] !== 'string' && !Array.isArray(json[header])) {
					throw new BareError(400, {
						code: 'INVALID_BARE_HEADER',
						id: `bare.headers.${header}`,
						message: `Header was not a String or Array.`,
					});
				}
			}

			Object.assign(headers, json);
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

async function tunnelRequest(
	serverConfig: ServerConfig,
	request: Request,
	res: ServerResponse<IncomingMessage>
): Promise<Response> {
	const abort = new AbortController();

	request.body.on('close', () => {
		if (!request.body.complete) abort.abort();
	});

	res.on('close', () => {
		abort.abort();
	});

	const { remote, headers } = readHeaders(request);

	const response = await fetch(
		serverConfig,
		request,
		abort.signal,
		headers,
		remote
	);

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
}

interface Meta {
	response?: {
		headers: BareHeaders;
	};
	set: number;
}

const tempMeta: Map<string, Meta> = new Map();

const metaExpiration = 30e3;

async function wsMeta(
	serverConfig: ServerConfig,
	request: Request
): Promise<Response> {
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

	tempMeta.delete(id);

	return json(200, {
		headers: meta.response?.headers,
	});
}

async function wsNewMeta(): Promise<Response> {
	const id = (await randomBytesAsync(32)).toString('hex');

	tempMeta.set(id, {
		set: Date.now(),
	});

	return new Response(Buffer.from(id));
}

async function tunnelSocket(
	serverConfig: ServerConfig,
	request: Request,
	socket: Duplex
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
		serverConfig,
		request,
		abort.signal,
		headers,
		remote
	);

	if (tempMeta.has(id)) {
		tempMeta.get(id)!.response = {
			headers: mapHeadersFromArray(rawHeaderNames(remoteResponse.rawHeaders), {
				...(<BareHeaders>remoteResponse.headers),
			}),
		};
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

	remoteSocket.on('close', () => {
		// console.log('Remote closed');
		socket.end();
	});

	socket.on('close', () => {
		// console.log('Serving closed');
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

	remoteSocket.pipe(socket);
	socket.pipe(remoteSocket);
}

export default function registerV1(server: Server) {
	server.routes.set('/v1/', tunnelRequest);
	server.routes.set('/v1/ws-new-meta', wsNewMeta);
	server.routes.set('/v1/ws-meta', wsMeta);
	server.socketRoutes.set('/v1/', tunnelSocket);

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
