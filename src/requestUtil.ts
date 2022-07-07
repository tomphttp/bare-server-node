import { Request } from './AbstractMessage';
import { BareError, ServerConfig } from './BareServer';
import http from 'node:http';
import https from 'node:https';
import { Duplex } from 'node:stream';

const httpAgent = new http.Agent();
const httpsAgent = new https.Agent();

export interface BareRemote {
	host: string;
	port: number | string;
	path: string;
	protocol: string;
}

export type BareHeaders = {
	[key: string]: string[] | string;
};

function outgoingError<T>(error: T): T | BareError {
	if (error instanceof Error) {
		switch ((<Error & { code?: string }>error).code) {
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

export async function fetch(
	config: ServerConfig,
	request: Request,
	requestHeaders: BareHeaders,
	url: BareRemote
): Promise<http.IncomingMessage> {
	const options = {
		host: url.host,
		port: url.port,
		path: url.path,
		method: request.method,
		headers: requestHeaders,
		setHost: false,
		localAddress: config.localAddress,
	};

	let outgoing: http.ClientRequest;

	if (url.protocol === 'https:') {
		outgoing = https.request({ ...options, agent: httpsAgent });
	} else if (url.protocol === 'http:') {
		outgoing = http.request({ ...options, agent: httpAgent });
	} else {
		throw new RangeError(`Unsupported protocol: '${url.protocol}'`);
	}

	request.body.pipe(outgoing);

	return await new Promise((resolve, reject) => {
		outgoing.on('response', (response: http.IncomingMessage) => {
			resolve(response);
		});

		outgoing.on('error', (error: Error) => {
			reject(outgoingError(error));
		});
	});
}

export async function upgradeFetch(
	serverConfig: ServerConfig,
	request: Request,
	requestHeaders: BareHeaders,
	remote: BareRemote
): Promise<[http.IncomingMessage, Duplex, Buffer]> {
	const options = {
		host: remote.host,
		port: remote.port,
		path: remote.path,
		headers: requestHeaders,
		method: request.method,
		setHost: false,
		localAddress: serverConfig.localAddress,
	};

	let outgoing: http.ClientRequest;

	if (remote.protocol === 'wss:') {
		outgoing = https.request({ ...options, agent: httpsAgent });
	} else if (remote.protocol === 'ws:') {
		outgoing = http.request({ ...options, agent: httpAgent });
	} else {
		throw new RangeError(`Unsupported protocol: '${remote.protocol}'`);
	}

	outgoing.end();

	return await new Promise((resolve, reject) => {
		outgoing.on('response', () => {
			reject('Remote did not upgrade the WebSocket');
		});

		outgoing.on(
			'upgrade',
			(request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
				resolve([request, socket, head]);
			}
		);

		outgoing.on('error', (error) => {
			reject(outgoingError(error));
		});
	});
}
