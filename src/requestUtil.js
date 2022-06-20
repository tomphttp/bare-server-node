import http from 'node:http';
import https from 'node:https';

/**
 * @typedef {object} BareRemote
 * @property {string} host
 * @property {number|string} port
 * @property {string} path
 * @property {string} protocol
 */

/**
 * @typedef {object} BareErrorBody
 * @property {string} code
 * @property {string} id
 * @property {string} [message]
 * @property {string} [stack]
 *
 */

/**
 *
 * @param {import('./Server.js').default} server
 * @param {import('./AbstractMessage.js').Request} request
 * @param {import('./Server.js').BareHeaders} requestHeaders
 * @param {BareRemote} url
 * @returns {Promise<import('http').ServerResponse>}
 */
export async function fetch(server, request, requestHeaders, url) {
	const options = {
		host: url.host,
		port: url.port,
		path: url.path,
		method: request.method,
		headers: requestHeaders,
		setHost: false,
		localAddress: server.localAddress,
	};

	let outgoing;

	if (url.protocol === 'https:') {
		outgoing = https.request({ ...options, agent: server.httpsAgent });
	} else if (url.protocol === 'http:') {
		outgoing = http.request({ ...options, agent: server.httpAgent });
	} else {
		throw new RangeError(`Unsupported protocol: '${url.protocol}'`);
	}

	request.body.pipe(outgoing);

	return await new Promise((resolve, reject) => {
		outgoing.on('response', resolve);
		outgoing.on('error', reject);
	});
}

/**
 *
 * @param {import('./Server.js').default} server
 * @param {import('./AbstractMessage.js').Request} request
 * @param {import('./Server.js').BareHeaders} requestHeaders
 * @param {BareRemote} remote
 * @returns {Promise<[http.IncomingMessage,import('stream').Duplex,Buffer]>}
 */
export async function upgradeFetch(server, request, requestHeaders, remote) {
	const options = {
		host: remote.host,
		port: remote.port,
		path: remote.path,
		headers: requestHeaders,
		method: request.method,
		setHost: false,
		localAddress: server.localAddress,
	};

	let outgoing;

	if (remote.protocol === 'wss:') {
		outgoing = https.request({ ...options, agent: server.httpsAgent });
	} else if (remote.protocol === 'ws:') {
		outgoing = http.request({ ...options, agent: server.httpAgent });
	} else {
		throw new RangeError(`Unsupported protocol: '${remote.protocol}'`);
	}

	outgoing.end();

	return await new Promise((resolve, reject) => {
		outgoing.on('response', () => {
			reject('Remote upgraded the WebSocket');
		});

		outgoing.on('upgrade', (...args) => {
			resolve(args);
		});

		outgoing.on('error', error => {
			reject(error);
		});
	});
}
