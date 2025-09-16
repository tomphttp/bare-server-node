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
import { type RateLimiterRes, RateLimiterMemory } from 'rate-limiter-flexible';
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

/**
 * Result of a rate limiting check.
 */
export interface RateLimitResult {
	/** Whether the request is allowed. */
	allowed: boolean;
	/** Rate limiter response containing timing and quota information. */
	rateLimiterRes?: RateLimiterRes;
}

/**
 * Connection limiting options to prevent resource exhaustion attacks.
 */
export interface ConnectionLimiterOptions {
	/**
	 * Maximum number of keep-alive connections per IP address.
	 * @default 10
	 */
	maxConnectionsPerIP?: number;
	/**
	 * Duration in seconds for the rate limit cooldown time window.
	 * @default 60
	 */
	windowDuration?: number;
	/**
	 * Block duration in seconds for during rate limit cooldown.
	 * @default 60
	 */
	blockDuration?: number;
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

export function json<T>(status: number, json: T): globalThis.Response {
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
	/**
	 * Connection limiting options to prevent resource exhaustion attacks.
	 */
	connectionLimiter?: ConnectionLimiterOptions;
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
	private rateLimiter?: RateLimiterMemory;
	/**
	 * @internal
	 */
	constructor(directory: string, options: Options) {
		super();
		this.directory = directory;
		this.options = options;

		if (options.connectionLimiter) {
			const maxConnections =
				options.connectionLimiter.maxConnectionsPerIP ?? 10;
			const duration = options.connectionLimiter.windowDuration ?? 60;
			const blockDuration = options.connectionLimiter.blockDuration ?? 60;

			this.rateLimiter = new RateLimiterMemory({
				points: maxConnections,
				duration,
				blockDuration,
			});
		}
	}

	/**
	 * Extracts client IP address from incoming request.
	 * Checks headers in order of preference: `x-forwarded-for`, `x-real-ip`, then socket address.
	 * @param req HTTP request to extract IP from.
	 * @return Client IP address as string, or `'unknown'` if not determinable.
	 */
	private getClientIP(req: IncomingMessage): string {
		const forwarded = req.headers['x-forwarded-for'] as string;
		if (forwarded) {
			return forwarded.split(',')[0].trim();
		}

		const realIP = req.headers['x-real-ip'] as string;
		if (realIP) {
			return realIP;
		}

		return req.socket.remoteAddress || 'unknown';
	}

	/**
	 * Checks if request should be rate limited based on connection type and IP to prevent resource exhaustion.
	 * @param req HTTP request to check.
	 * @return Promise resolving to rate limit result with allowed status and limiter response.
	 */
	private async checkRateLimit(req: IncomingMessage): Promise<RateLimitResult> {
		if (!this.rateLimiter) {
			return { allowed: true };
		}

		const ip = this.getClientIP(req);

		try {
			const connection = req.headers.connection?.toLowerCase();
			const keepAlive =
				connection === 'keep-alive' ||
				(req.httpVersion === '1.1' && connection !== 'close');

			if (keepAlive) {
				const rateLimiterRes = await this.rateLimiter.consume(ip);
				return { allowed: true, rateLimiterRes };
			} else {
				const rateLimiterRes = await this.rateLimiter.get(ip);
				if (rateLimiterRes && rateLimiterRes.remainingPoints <= 0) {
					return { allowed: false, rateLimiterRes };
				}
				return { allowed: true };
			}
		} catch (rateLimiterRes) {
			return {
				allowed: false,
				rateLimiterRes: rateLimiterRes as RateLimiterRes,
			};
		}
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
		const rateResult = await this.checkRateLimit(req);
		if (!rateResult.allowed) {
			const retryAfter = rateResult.rateLimiterRes
				? Math.round(rateResult.rateLimiterRes.msBeforeNext / 1000) || 1
				: 60;
			const maxConnections =
				this.options.connectionLimiter?.maxConnectionsPerIP ?? 10;

			socket.write(
				'HTTP/1.1 429 Too Many Connections\r\n' +
					'Content-Type: application/json\r\n' +
					`Retry-After: ${retryAfter}\r\n` +
					`RateLimit-Limit: ${maxConnections}\r\n` +
					`RateLimit-Remaining: ${rateResult.rateLimiterRes?.remainingPoints ?? 0}\r\n` +
					`RateLimit-Reset: ${
						rateResult.rateLimiterRes
							? Math.ceil(rateResult.rateLimiterRes.msBeforeNext / 1000)
							: 60
					}\r\n` +
					'\r\n' +
					JSON.stringify({
						code: 'CONNECTION_LIMIT_EXCEEDED',
						id: 'error.TooManyConnections',
						message: 'Too many keep-alive connections from this IP address',
					}),
			);
			socket.end();
			return;
		}

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
		const rateResult = await this.checkRateLimit(req);
		if (!rateResult.allowed) {
			const retryAfter = rateResult.rateLimiterRes
				? Math.round(rateResult.rateLimiterRes.msBeforeNext / 1000) || 1
				: 60;
			const maxConnections =
				this.options.connectionLimiter?.maxConnectionsPerIP ?? 10;

			res.writeHead(429, 'Too Many Connections', {
				'Content-Type': 'application/json',
				'Retry-After': retryAfter.toString(),
				'RateLimit-Limit': maxConnections.toString(),
				'RateLimit-Remaining': (
					rateResult.rateLimiterRes?.remainingPoints ?? 0
				).toString(),
				'RateLimit-Reset': (rateResult.rateLimiterRes
					? Math.ceil(rateResult.rateLimiterRes.msBeforeNext / 1000)
					: 60
				).toString(),
			});
			res.end(
				JSON.stringify({
					code: 'CONNECTION_LIMIT_EXCEEDED',
					id: 'error.TooManyConnections',
					message: 'Too many keep-alive connections from this IP address',
				}),
			);
			return;
		}

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
