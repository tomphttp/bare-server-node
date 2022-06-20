import registerV1 from './V1.js';
import registerV2 from './V2.js';
import { Request, Response, writeResponse } from './AbstractMessage.js';
import http from 'http';
import https from 'https';
import createHttpError from 'http-errors';

/**
 * @typedef {Object.<string, string|string[]>} BareHeaders
 */

/**
 *
 * Bare Error
 */
export class BareError extends Error {
	/**
	 *
	 * @param {number} status
	 * @param {BareErrorBody} body
	 */
	constructor(status, body) {
		super(body.message || body.code);
		/**
		 * @type {number}
		 */
		this.status = status;
		/**
		 * @type {BareErrorBody}
		 */
		this.body = body;
	}
}

const project = {
	name: 'TOMPHTTP NodeJS Bare Server',
	repository: 'https://github.com/tomphttp/bare-server-node',
};

export function json(status, json) {
	const send = Buffer.from(JSON.stringify(json, null, '\t'));

	return new Response(send, {
		status,
		headers: {
			'content-type': 'application/json',
			'content-length': send.byteLength,
		},
	});
}

/**
 * @typedef {object} BareMaintainer
 * @property {string} [email]
 * @property {string} [website]
 */

/**
 * @typedef {object} BareProject
 * @property {string} [name]
 * @property {string} [description]
 * @property {string} [email]
 * @property {string} [website]
 * @property {string} [repository]
 */

/**
 * @typedef {'JS'|'TS'|'Java'|'PHP'|'Rust'|'C'|'C++'|'C#'|'Ruby'|'Go'|'Crystal'|'Bash'|string} BareLanguage
 */

/**
 * @typedef {object} BareManifest
 * @property {string} [maintainer]
 * @property {string} [project]
 * @property {string[]} versions
 * @property {BareLanguage} [language]
 * @property {number} [memoryUsage]
 */

/**
 * @typedef {object} BareServerInit
 * @property {boolean} [logErrors]
 * @property {string} [localAddress]
 * @property {BareMaintainer} [maintainer]
 */
// directory, logErrors = false, localAddress, maintainer

export default class Server {
	/**
	 *
	 * @param {string} directory
	 * @param {BareServerInit} init
	 */
	constructor(directory, init = {}) {
		if (init.logErrors) {
			/**
			 * @type {boolean}
			 */
			this.logErrors = true;
		} else {
			this.logErrors = false;
		}

		/**
		 * @type {Map<string, (server: Server, request: Request) => Promise<Response>>}
		 */
		this.routes = new Map();
		/**
		 * @type {Map<string, (server: Server, request: Request, socket: import('stream').Duplex, head: Buffer) => Promise<Response>>}
		 */
		this.socketRoutes = new Map();
		/**
		 * @type {Set<() => void>}
		 */
		this.onClose = new Set();

		/**
		 * @type {http.Agent}
		 */
		this.httpAgent = http.Agent({
			keepAlive: true,
		});

		/**
		 * @type {https.Agent}
		 */
		this.httpsAgent = https.Agent({
			keepAlive: true,
		});

		if (init.localAddress) {
			this.localAddress = init.localAddress;
		}

		if (init.maintainer) {
			/**
			 * @type {BareMaintainer|undefined}
			 */
			this.maintainer = init.maintainer;
		}

		if (typeof directory !== 'string') {
			throw new Error('Directory must be specified.');
		}

		if (!directory.startsWith('/') || !directory.endsWith('/')) {
			throw new RangeError('Directory must start and end with /');
		}

		/**
		 * @type {string}
		 */
		this.directory = directory;

		this.routes.set('/', () => {
			return json(200, this.instanceInfo);
		});

		registerV1(this);
		registerV2(this);
	}
	/**
	 * Remove all timers and listeners
	 */
	close() {
		for (const callback of this.onClose) {
			callback();
		}
	}
	/**
	 *
	 * @param {ClientRequest} request
	 * @returns {boolean}
	 */
	shouldRoute(request) {
		return request.url.startsWith(this.directory);
	}
	/**
	 *
	 * @returns {BareManifest}
	 */
	get instanceInfo() {
		return {
			versions: ['v1', 'v2'],
			language: 'NodeJS',
			memoryUsage:
				Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100,
			maintainer: this.maintainer,
			project,
		};
	}
	/**
	 *
	 * @param {http.IncomingMessage} req
	 * @param {import('stream').Duplex} socket
	 * @param {Buffer} head
	 */
	async routeUpgrade(req, socket, head) {
		const request = new Request(req, {
			method: req.method,
			path: req.url,
			headers: req.headers,
		});

		const service = request.url.pathname.slice(this.directory.length - 1);

		if (this.socketRoutes.has(service)) {
			const call = this.socketRoutes.get(service);

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
	/**
	 *
	 * @param {import('node:http').ClientRequest} req
	 * @param {import('node:http').ServerResponse} res
	 */
	async routeRequest(req, res) {
		const request = new Request(req, {
			method: req.method,
			path: req.url,
			headers: req.headers,
		});

		const service = request.url.pathname.slice(this.directory.length - 1);
		let response;

		try {
			if (request.method === 'OPTIONS') {
				response = new Response(undefined, { status: 200 });
			} else if (this.routes.has(service)) {
				const call = this.routes.get(service);

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
					stack: new Error(error).stack,
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
