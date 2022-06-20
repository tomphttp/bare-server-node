import http from 'node:http';
import https from 'node:https';
import { BareError } from './Server.js';

/**
 *
 * @param {Error} error
 * @returns {Error|BareError}
 */
function outgoingError(error) {
	if (error instanceof Error) {
		switch (error.code) {
			case 'ENOTFOUND':
				return new BareError(500, {
					code: 'HOST_NOT_FOUND',
					id: 'request',
					message: 'The specified host could not be resolved.',
				});
			case 'ECONNREFUSED':
				return new BareError(500, {
					code: 'CONNECTION_REFUSED',
					id: 'response',
					message: 'The remote rejected the request.',
				});
			case 'ECONNRESET':
				return new BareError(500, {
					code: 'CONNECTION_RESET',
					id: 'response',
					message: 'The request was forcibly closed.',
				});
			case 'ETIMEOUT':
				return new BareError(500, {
					code: 'CONNECTION_TIMEOUT',
					id: 'response',
					message: 'The response timed out.',
				});
		}
	}

	return error;
}

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
		outgoing.on('response', response => {
			resolve(response);
		});

		outgoing.on('error', error => {
			reject(outgoingError(error));
		});
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
		outgoing.on('response', r => {
			const cu = [];
			r.on('data', c => cu.push(c));
			r.on('end', () => {
				console.log(Buffer.concat(cu).toString());
			});
			reject('Remote did not upgrade the WebSocket');
		});

		outgoing.on('upgrade', (...args) => {
			resolve(args);
		});

		outgoing.on('error', error => {
			reject(outgoingError(error));
		});
	});
}
