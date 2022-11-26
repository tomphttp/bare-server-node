import { Request, Response, writeResponse } from './AbstractMessage.js';
import type { BareHeaders } from './requestUtil.js';
import createHttpError from 'http-errors';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Agent as HttpAgent } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

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
	readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
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

export interface BareServerInit {
	logErrors?: boolean;
	localAddress?: string;
	maintainer?: BareMaintainer;
}

export interface ServerConfig {
	logErrors: boolean;
	localAddress?: string;
	maintainer?: BareMaintainer;
}

export type RouteCallback = (
	request: Request,
	response: ServerResponse<IncomingMessage>,
	serverConfig: ServerConfig,
	httpAgent: HttpAgent,
	httpsAgent: HttpsAgent
) => Promise<Response> | Response;

export type SocketRouteCallback = (
	request: Request,
	socket: Duplex,
	head: Buffer,
	serverConfig: ServerConfig,
	httpAgent: HttpAgent,
	httpsAgent: HttpsAgent
) => Promise<void> | void;

export default class Server extends EventEmitter {
	routes: Map<string, RouteCallback>;
	socketRoutes: Map<string, SocketRouteCallback>;
	private directory: string;
	private config: ServerConfig;
	private httpAgent = new HttpAgent({
		keepAlive: true,
		timeout: 12e3,
	});
	private httpsAgent = new HttpsAgent({
		keepAlive: true,
		timeout: 12e3,
	});
	/**
	 * @internal
	 */
	constructor(directory: string, init: Partial<ServerConfig> = {}) {
		super();

		init.logErrors ??= false;

		this.config = <ServerConfig>init;

		this.routes = new Map();
		this.socketRoutes = new Map();

		if (typeof directory !== 'string') {
			throw new Error('Directory must be specified.');
		}

		if (!directory.startsWith('/') || !directory.endsWith('/')) {
			throw new RangeError('Directory must start and end with /');
		}

		this.directory = directory;
	}
	/**
	 * Remove all timers and listeners
	 */
	close() {
		this.httpAgent.destroy();
		this.httpsAgent.destroy();
		this.emit('close');
	}
	shouldRoute(request: IncomingMessage): boolean {
		return request.url !== undefined && request.url.startsWith(this.directory);
	}
	get instanceInfo(): BareManifest {
		return {
			versions: ['v1', 'v2'],
			language: 'NodeJS',
			memoryUsage:
				Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100,
			maintainer: this.config.maintainer,
			project,
		};
	}
	async routeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
		const request = new Request(req, {
			method: req.method!,
			path: req.url!,
			headers: <BareHeaders>req.headers,
		});

		const service = request.url.pathname.slice(this.directory.length - 1);

		if (this.socketRoutes.has(service)) {
			const call = this.socketRoutes.get(service)!;

			try {
				await call(
					request,
					socket,
					head,
					this.config,
					this.httpAgent,
					this.httpsAgent
				);
			} catch (error) {
				if (this.config.logErrors) {
					console.error(error);
				}

				socket.end();
			}
		} else {
			socket.end();
		}
	}
	async routeRequest(req: IncomingMessage, res: ServerResponse) {
		const request = new Request(req, {
			method: req.method!,
			path: req.url!,
			headers: <BareHeaders>req.headers,
		});

		const service = request.url.pathname.slice(this.directory.length - 1);
		let response: Response;

		try {
			if (request.method === 'OPTIONS') {
				response = new Response(undefined, { status: 200 });
			} else if (service === '/') {
				response = json(200, this.instanceInfo);
			} else if (this.routes.has(service)) {
				const call = this.routes.get(service)!;
				response = await call(
					request,
					res,
					this.config,
					this.httpAgent,
					this.httpsAgent
				);
			} else {
				throw new createHttpError.NotFound();
			}
		} catch (error) {
			if (this.config.logErrors) {
				console.error(error);
			}

			if (error instanceof Error) {
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
				if (this.config.logErrors) {
					console.error(
						'Cannot',
						request.method,
						request.url.pathname,
						': Route did not return a response.'
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

		writeResponse(response, res);
	}
}
