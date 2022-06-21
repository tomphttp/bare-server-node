import { Request, Response, writeResponse } from './AbstractMessage';
import { Duplex } from 'stream';
import http from 'http';
import https from 'https';
import createHttpError from 'http-errors';
import { BareHeaders } from './requestUtil';

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

const project = {
	name: 'TOMPHTTP NodeJS Bare Server',
	repository: 'https://github.com/tomphttp/bare-server-node',
};

export function json(status: number, json: any) {
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
};

export type BareLanguage =
	| 'NodeJS'
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
	| 'Bash'
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

export default class BareServer {
	directory: string;
	logErrors: boolean;
	routes: Map<
		string,
		(server: BareServer, request: Request) => Promise<Response>
	>;
	socketRoutes: Map<
		string,
		(
			server: BareServer,
			request: Request,
			socket: import('stream').Duplex,
			head: Buffer
		) => void
	>;
	onClose: Set<() => void>;
	httpAgent: http.Agent;
	httpsAgent: https.Agent;
	localAddress?: string;
	maintainer?: BareMaintainer;
	constructor(directory: string, init: BareServerInit = {}) {
		if (init.logErrors) {
			/**
			 * @type {boolean}
			 */
			this.logErrors = true;
		} else {
			this.logErrors = false;
		}

		this.routes = new Map();
		this.socketRoutes = new Map();
		this.onClose = new Set();

		this.httpAgent = new http.Agent({
			keepAlive: true,
		});

		this.httpsAgent = new https.Agent({
			keepAlive: true,
		});

		if (init.localAddress) {
			this.localAddress = init.localAddress;
		}

		if (init.maintainer) {
			this.maintainer = init.maintainer;
		}

		if (typeof directory !== 'string') {
			throw new Error('Directory must be specified.');
		}

		if (!directory.startsWith('/') || !directory.endsWith('/')) {
			throw new RangeError('Directory must start and end with /');
		}

		this.directory = directory;

		this.routes.set('/', async () => {
			return json(200, this.instanceInfo);
		});
	}
	/**
	 * Remove all timers and listeners
	 */
	close() {
		for (const callback of this.onClose) {
			callback();
		}
	}
	shouldRoute(request: http.IncomingMessage): boolean {
		return request.url?.startsWith(this.directory) || false;
	}
	get instanceInfo(): BareManifest {
		return {
			versions: ['v1', 'v2'],
			language: 'NodeJS',
			memoryUsage:
				Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100,
			maintainer: this.maintainer,
			project,
		};
	}
	async routeUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
		const request = new Request(req, {
			method: req.method!,
			path: req.url!,
			headers: <BareHeaders>req.headers,
		});

		const service = request.url.pathname.slice(this.directory.length - 1);

		if (this.socketRoutes.has(service)) {
			const call = this.socketRoutes.get(service)!;

			try {
				await call(this, request, socket, head);
			} catch (error) {
				if (this.logErrors) {
					console.error(error);
				}

				socket.end();
			}
		} else {
			socket.end();
		}
	}
	async routeRequest(req: http.IncomingMessage, res: http.ServerResponse) {
		const request = new Request(req, {
			method: req.method!,
			path: req.url!,
			headers: <BareHeaders>req.headers,
		});

		const service = request.url.pathname.slice(this.directory.length - 1);
		let response;

		try {
			if (request.method === 'OPTIONS') {
				response = new Response(undefined, { status: 200 });
			} else if (this.routes.has(service)) {
				const call = this.routes.get(service)!;
				response = await call(this, request);
			} else {
				throw new createHttpError.NotFound();
			}
		} catch (error) {
			if (this.logErrors) {
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
				if (this.logErrors) {
					console.error(
						'Cannot',
						req.method,
						req.url,
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
