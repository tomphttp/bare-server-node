import type { LookupOneOptions } from 'node:dns';
import EventEmitter from 'node:events';
import { readFileSync } from 'node:fs';
import type {
	Agent as HttpAgent,
	IncomingMessage,
	ServerResponse,
} from 'node:http';
import type { Agent as HttpsAgent } from 'node:https';
import { join } from 'node:path';
import { Readable, type Duplex } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import createHttpError from 'http-errors';
import type WebSocket from 'ws';
// @internal
import type { JSONDatabaseAdapter } from './Meta.js';
import { nullMethod } from './requestUtil.js';

export interface BareRequest extends Request {
	native: IncomingMessage;
}

export interface BareErrorBody {
	code: string;
	id: string;
	message?: string;
	stack?: string;
}

export class BareError extends Error {
	status: number;
	body: BareErrorBody;
	constructor(status: number, body: BareErrorBody) {
		super(body.message || body.code);
		this.status = status;
		this.body = body;
	}
}

export const pkg = JSON.parse(
	readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
) as { version: string };

const project: BareProject = {
	name: 'bare-server-node',
	description: 'TOMPHTTP NodeJS Bare Server',
	repository: 'https://github.com/tomphttp/bare-server-node',
	version: pkg.version,
};

export function json<T>(status: number, json: T) {
	const send = Buffer.from(JSON.stringify(json, null, '\t'));

	return new Response(send, {
		status,
		headers: {
			'content-type': 'application/json',
			'content-length': send.byteLength.toString(),
		},
	});
}

export type BareMaintainer = {
	email?: string;
	website?: string;
};

export type BareProject = {
	name?: string;
	description?: string;
	email?: string;
	website?: string;
	repository?: string;
	version?: string;
};

export type BareLanguage =
	| 'NodeJS'
	| 'ServiceWorker'
	| 'Deno'
	| 'Java'
	| 'PHP'
	| 'Rust'
	| 'C'
	| 'C++'
	| 'C#'
	| 'Ruby'
	| 'Go'
	| 'Crystal'
	| 'Shell'
	| string;

export type BareManifest = {
	maintainer?: BareMaintainer;
	project?: BareProject;
	versions: string[];
	language: BareLanguage;
	memoryUsage?: number;
};

export interface Options {
	logErrors: boolean;
	/**
	 * Callback for filtering the remote URL.
	 * @returns Nothing
	 * @throws An error if the remote is bad.
	 */
	filterRemote?: (remote: Readonly<URL>) => Promise<void> | void;
	/**
	 * DNS lookup
	 * May not get called when remote.host is an IP
	 * Use in combination with filterRemote to block IPs
	 */
	lookup: (
		hostname: string,
		options: LookupOneOptions,
		callback: (
			err: NodeJS.ErrnoException | null,
			address: string,
			family: number,
		) => void,
	) => void;
	localAddress?: string;
	family?: number;
	maintainer?: BareMaintainer;
	httpAgent: HttpAgent;
	httpsAgent: HttpsAgent;
	database: JSONDatabaseAdapter;
	wss: WebSocket.Server;
}

export type RouteCallback = (
	request: BareRequest,
	response: ServerResponse<IncomingMessage>,
	options: Options,
) => Promise<Response> | Response;

export type SocketRouteCallback = (
	request: BareRequest,
	socket: Duplex,
	head: Buffer,
	options: Options,
) => Promise<void> | void;

export default class Server extends EventEmitter {
	directory: string;
	routes = new Map<string, RouteCallback>();
	socketRoutes = new Map<string, SocketRouteCallback>();
	versions: string[] = [];
	private closed = false;
	private options: Options;
	/**
	 * @internal
	 */
	constructor(directory: string, options: Options) {
		super();
		this.directory = directory;
		this.options = options;
	}
	/**
	 * Remove all timers and listeners
	 */
	close() {
		this.closed = true;
		this.emit('close');
	}
	shouldRoute(request: IncomingMessage): boolean {
		return (
			!this.closed &&
			request.url !== undefined &&
			request.url.startsWith(this.directory)
		);
	}
	get instanceInfo(): BareManifest {
		return {
			versions: this.versions,
			language: 'NodeJS',
			memoryUsage:
				Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100,
			maintainer: this.options.maintainer,
			project,
		};
	}
	async routeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
		const request = new Request(new URL(req.url!, 'http://bare-server-node'), {
			method: req.method,
			body: nullMethod.includes(req.method || '') ? undefined : req,
			headers: req.headers as HeadersInit,
		}) as BareRequest;

		request.native = req;

		const service = new URL(request.url).pathname.slice(
			this.directory.length - 1,
		);

		if (this.socketRoutes.has(service)) {
			const call = this.socketRoutes.get(service)!;

			try {
				await call(request, socket, head, this.options);
			} catch (error) {
				if (this.options.logErrors) {
					console.error(error);
				}

				socket.end();
			}
		} else {
			socket.end();
		}
	}
	async routeRequest(req: IncomingMessage, res: ServerResponse) {
		const request = new Request(new URL(req.url!, 'http://bare-server-node'), {
			method: req.method,
			body: nullMethod.includes(req.method || '') ? undefined : req,
			headers: req.headers as HeadersInit,
			duplex: 'half',
		}) as BareRequest;

		request.native = req;

		const service = new URL(request.url).pathname.slice(
			this.directory.length - 1,
		);
		let response: Response;

		try {
			if (request.method === 'OPTIONS') {
				response = new Response(undefined, { status: 200 });
			} else if (service === '/') {
				response = json(200, this.instanceInfo);
			} else if (this.routes.has(service)) {
				const call = this.routes.get(service)!;
				response = await call(request, res, this.options);
			} else {
				throw new createHttpError.NotFound();
			}
		} catch (error) {
			if (this.options.logErrors) console.error(error);

			if (createHttpError.isHttpError(error)) {
				response = json(error.statusCode, {
					code: 'UNKNOWN',
					id: `error.${error.name}`,
					message: error.message,
					stack: error.stack,
				});
			} else if (error instanceof Error) {
				response = json(500, {
					code: 'UNKNOWN',
					id: `error.${error.name}`,
					message: error.message,
					stack: error.stack,
				});
			} else {
				response = json(500, {
					code: 'UNKNOWN',
					id: 'error.Exception',
					message: error,
					stack: new Error(<string | undefined>error).stack,
				});
			}

			if (!(response instanceof Response)) {
				if (this.options.logErrors) {
					console.error(
						'Cannot',
						request.method,
						new URL(request.url).pathname,
						': Route did not return a response.',
					);
				}

				throw new createHttpError.InternalServerError();
			}
		}

		response.headers.set('x-robots-tag', 'noindex');
		response.headers.set('access-control-allow-headers', '*');
		response.headers.set('access-control-allow-origin', '*');
		response.headers.set('access-control-allow-methods', '*');
		response.headers.set('access-control-expose-headers', '*');
		// don't fetch preflight on every request...
		// instead, fetch preflight every 10 minutes
		response.headers.set('access-control-max-age', '7200');

		res.writeHead(
			response.status,
			response.statusText,
			Object.fromEntries(response.headers),
		);

		if (response.body) {
			const body = Readable.fromWeb(response.body as ReadableStream);
			body.pipe(res);
			res.on('close', () => body.destroy());
		} else res.end();
	}
}
