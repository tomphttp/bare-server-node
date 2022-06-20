import { Response } from './AbstractMessage.js';
import { Headers } from 'fetch-headers';
import { mapHeadersFromArray, rawHeaderNames } from './headerUtil.js';
import { decodeProtocol } from './encodeProtocol.js';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { BareError, json } from './Server.js';
import { fetch, upgradeFetch } from './requestUtil.js';

/**
 * @typedef {object} BareRemote
 * @property {string} host
 * @property {number|string} port
 * @property {string} path
 * @property {string} protocol
 */

const validProtocols = ['http:', 'https:', 'ws:', 'wss:'];

const randomBytesAsync = promisify(randomBytes);

function loadForwardedHeaders(forward, target, request) {
	for (const header of forward) {
		if (request.headers.has(header)) {
			target[header] = request.headers.get(header);
		}
	}
}

/**
 * @typedef {object} BareHeaderData
 * @property {BareRemote} remote
 * @property {import('./Server.js').BareHeaders} sendHeaders
 * @property {string[]} passHeaders
 * @property {number[]} passStatus
 * @property {string[]} forwardHeaders
 */

/**
 *
 * @param {import('./AbstractMessage').Request} request
 * @returns {BareHeaderData}
 */
function readHeaders(request) {
	const remote = Object.setPrototypeOf({}, null);
	const headers = Object.setPrototypeOf({}, null);

	for (const remoteProp of ['host', 'port', 'protocol', 'path']) {
		const header = `x-bare-${remoteProp}`;

		if (request.headers.has(header)) {
			let value = request.headers.get(header);

			switch (remoteProp) {
				case 'port':
					value = parseInt(value);
					if (isNaN(value)) {
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
			const json = JSON.parse(request.headers.get('x-bare-headers'));

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
			json = JSON.parse(request.headers.get('x-bare-forward-headers'));
		} catch (error) {
			throw new BareError(400, {
				code: 'INVALID_BARE_HEADER',
				id: `request.headers.x-bare-forward-headers`,
				message: `Header contained invalid JSON. (${error.message})`,
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

	return { remote, headers };
}

/**
 *
 * @param {import('./Server.js').default} server
 * @param {import('./AbstractMessage.js').Request} request
 * @returns {Promise<Response>}
 */
async function tunnelRequest(server, request) {
	const { remote, headers } = readHeaders(request);

	const response = await fetch(server, request, headers, remote);

	const responseHeaders = new Headers();

	for (const header in response.headers) {
		if (header === 'content-encoding' || header === 'x-content-encoding') {
			responseHeaders.set('content-encoding', response.headers[header]);
		} else if (header === 'content-length') {
			responseHeaders.set('content-length', response.headers[header]);
		}
	}

	responseHeaders.set(
		'x-bare-headers',
		JSON.stringify(
			mapHeadersFromArray(rawHeaderNames(response.rawHeaders), {
				...response.headers,
			})
		)
	);
	responseHeaders.set('x-bare-status', response.statusCode);
	responseHeaders.set('x-bare-status-text', response.statusMessage);

	return new Response(response, { status: 200, headers: responseHeaders });
}

/**
 * @typedef {object} Meta
 * @property {import('http').OutgoingMessage} [response]
 * @property {number} set
 */

/**
 * @type {Map<string, Meta>}
 */
const tempMeta = new Map();

const metaExpiration = 30e3;

/**
 *
 * @param {import('./Server.js').default} server
 * @param {import('./AbstractMessage.js').Request} request
 * @returns {Promise<Response>}
 */
async function wsMeta(server, request) {
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

	const id = request.headers.get('x-bare-id');

	if (!tempMeta.has(id)) {
		throw new BareError(400, {
			code: 'INVALID_BARE_HEADER',
			id: 'request.headers.x-bare-id',
			message: 'Unregistered ID',
		});
	}

	const meta = tempMeta.get(id);

	tempMeta.delete(id);

	return json(200, {
		remote: meta.remote,
	});
}

/**
 *
 * @returns {Promise<Response>}
 */
async function wsNewMeta() {
	const id = (await randomBytesAsync(32)).toString('hex');

	tempMeta.set(id, {
		set: Date.now(),
	});

	return new Response(Buffer.from(id.toString('hex')));
}

/**
 *
 * @param {import('./Server.js').default} server
 * @param {import('./AbstractMessage.js').Request} request
 * @param {import('stream').Duplex} socket
 * @returns
 */
async function tunnelSocket(server, request, socket) {
	if (!request.headers.has('sec-websocket-protocol')) {
		socket.end();
		return;
	}

	const [firstProtocol, data] = request.headers
		.get('sec-websocket-protocol')
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
		server,
		request,
		headers,
		remote
	);

	if (tempMeta.has(id)) {
		tempMeta.get(id).response = remoteResponse;
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

	remoteSocket.on('error', error => {
		server.error('Remote socket error:', error);
		socket.end();
	});

	socket.on('error', error => {
		server.error('Serving socket error:', error);
		remoteSocket.end();
	});

	remoteSocket.pipe(socket);
	socket.pipe(remoteSocket);
}

/**
 *
 * @param {import('./Server.js').default} server
 */
export default function registerV1(server) {
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

	server.onClose.add(() => {
		clearInterval(interval);
	});
}
