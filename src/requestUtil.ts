import { getRandomValues } from 'node:crypto';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import type { ErrorEvent } from 'ws';
import WebSocket from 'ws';
import type { Request } from './AbstractMessage.js';
import { BareError } from './BareServer.js';
import type { Options } from './BareServer.js';

export type BareHeaders = Record<string, string | string[]>;

export function randomHex(byteLength: number) {
	const bytes = new Uint8Array(byteLength);
	getRandomValues(bytes);
	let hex = '';
	for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
	return hex;
}

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
	request: Request,
	signal: AbortSignal,
	requestHeaders: BareHeaders,
	remote: URL,
	options: Options
): Promise<IncomingMessage> {
	if (options.filterRemote) await options.filterRemote(remote);

	const req: RequestOptions = {
		method: request.method,
		headers: requestHeaders,
		setHost: false,
		signal,
		localAddress: options.localAddress,
		family: options.family,
		lookup: options.lookup,
	};

	let outgoing: ClientRequest;

	// NodeJS will convert the URL into HTTP options automatically
	// see https://github.com/nodejs/node/blob/e30e71665cab94118833cc536a43750703b19633/lib/internal/url.js#L1277

	if (remote.protocol === 'https:')
		outgoing = httpsRequest(remote, {
			...req,
			agent: options.httpsAgent,
		});
	else if (remote.protocol === 'http:')
		outgoing = httpRequest(remote, {
			...req,
			agent: options.httpAgent,
		});
	else throw new RangeError(`Unsupported protocol: '${remote.protocol}'`);

	request.body.pipe(outgoing);

	return await new Promise((resolve, reject) => {
		outgoing.on('response', (response: IncomingMessage) => {
			resolve(response);
		});

		outgoing.on('upgrade', (req, socket) => {
			reject('Remote did not send a response');
			socket.destroy();
		});

		outgoing.on('error', (error: Error) => {
			reject(outgoingError(error));
		});
	});
}

export async function upgradeFetch(
	request: Request,
	signal: AbortSignal,
	requestHeaders: BareHeaders,
	remote: URL,
	options: Options
): Promise<[res: IncomingMessage, socket: Duplex, head: Buffer]> {
	if (options.filterRemote) await options.filterRemote(remote);

	const req: RequestOptions = {
		headers: requestHeaders,
		method: request.method,
		timeout: 12e3,
		setHost: false,
		signal,
		localAddress: options.localAddress,
		family: options.family,
		lookup: options.lookup,
	};

	let outgoing: ClientRequest;

	// NodeJS will convert the URL into HTTP options automatically
	// see https://github.com/nodejs/node/blob/e30e71665cab94118833cc536a43750703b19633/lib/internal/url.js#L1277

	// calling .replace on remote may look like it replaces other occurrences of wss:, but it only replaces the first which is remote.protocol

	if (remote.protocol === 'wss:')
		outgoing = httpsRequest(remote.toString().replace('wss:', 'https:'), {
			...req,
			agent: options.httpsAgent,
		});
	else if (remote.protocol === 'ws:')
		outgoing = httpRequest(remote.toString().replace('ws:', 'http:'), {
			...req,
			agent: options.httpAgent,
		});
	else throw new RangeError(`Unsupported protocol: '${remote.protocol}'`);

	outgoing.end();

	return await new Promise((resolve, reject) => {
		outgoing.on('response', (res) => {
			reject(new Error('Remote did not upgrade the WebSocket'));
			res.destroy();
		});

		outgoing.on('upgrade', (res, socket, head) => {
			resolve([res, socket, head]);
		});

		outgoing.on('error', (error) => {
			reject(outgoingError(error));
		});
	});
}

export async function webSocketFetch(
	request: Request,
	requestHeaders: BareHeaders,
	remote: URL,
	options: Options
): Promise<[req: IncomingMessage, socket: WebSocket]> {
	if (options.filterRemote) await options.filterRemote(remote);

	const req = {
		headers: requestHeaders,
		method: request.method,
		timeout: 12e3,
		setHost: false,
		localAddress: options.localAddress,
		family: options.family,
		lookup: options.lookup,
	};

	let outgoing: WebSocket;

	if (remote.protocol === 'wss:')
		outgoing = new WebSocket(remote, {
			...req,
			agent: options.httpsAgent,
		});
	else if (remote.protocol === 'ws:')
		outgoing = new WebSocket(remote, {
			...req,
			agent: options.httpAgent,
		});
	else throw new RangeError(`Unsupported protocol: '${remote.protocol}'`);

	return await new Promise((resolve, reject) => {
		let request: IncomingMessage | undefined;

		const cleanup = () => {
			outgoing.removeEventListener('open', openListener);
			outgoing.removeEventListener('open', openListener);
		};

		outgoing.on('upgrade', (req) => {
			request = req;
		});

		const openListener = () => {
			cleanup();
			resolve([request!, outgoing]);
		};

		const errorListener = (event: ErrorEvent) => {
			cleanup();
			reject(outgoingError(event.error));
		};

		outgoing.addEventListener('open', openListener);
		outgoing.addEventListener('error', errorListener);
	});
}
