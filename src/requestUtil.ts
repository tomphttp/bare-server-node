import type { Request } from './AbstractMessage.js';
import { BareError } from './BareServer.js';
import type { Options } from './BareServer.js';
import { getRandomValues } from 'node:crypto';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

export interface BareRemote {
	host: string;
	port: number | string;
	path: string;
	protocol: string;
}

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
	remote: BareRemote,
	options: Options
): Promise<IncomingMessage> {
	if (options.filterRemote) await options.filterRemote(remote);

	const req: RequestOptions = {
		host: remote.host,
		port: remote.port,
		path: remote.path,
		method: request.method,
		headers: requestHeaders,
		setHost: false,
		signal,
		localAddress: options.localAddress,
		family: options.family,
		lookup: options.lookup,
	};

	let outgoing: ClientRequest;

	if (remote.protocol === 'https:')
		outgoing = httpsRequest({
			...req,
			agent: options.httpsAgent,
		});
	else if (remote.protocol === 'http:')
		outgoing = httpRequest({
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
	remote: BareRemote,
	options: Options
): Promise<[res: IncomingMessage, socket: Duplex, head: Buffer]> {
	if (options.filterRemote) await options.filterRemote(remote);

	const req: RequestOptions = {
		host: remote.host,
		port: remote.port,
		path: remote.path,
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

	if (remote.protocol === 'wss:')
		outgoing = httpsRequest({ ...req, agent: options.httpsAgent });
	else if (remote.protocol === 'ws:')
		outgoing = httpRequest({ ...req, agent: options.httpAgent });
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
