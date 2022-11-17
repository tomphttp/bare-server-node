import type { ServerConfig } from './BareServer.js';
import { MemoryDatabase } from './Database.js';
import createBareServer from './createServer.js';
import Hub from 'cluster-hub';
import { Command } from 'commander';
import { config } from 'dotenv';
import type { Worker } from 'node:cluster';
import cluster from 'node:cluster';
import http from 'node:http';
import { cpus } from 'node:os';

const hub = new Hub() as BareHub;

interface BareHub extends Hub {
	requestMaster(
		type: string | symbol,
		data?: unknown,
		callback?: Hub.Callback
	): boolean;
	requestMaster(
		type: 'getKey',
		data: { key: string },
		callback?: (err: Error | null, response: string | void) => void
	): boolean;
	requestMaster(
		type: 'setKey',
		data: { key: string; value: string },
		callback?: (err: Error | null, response: void) => void
	): boolean;
	requestMaster(
		type: 'hasKey',
		data: { key: string },
		callback?: (err: Error | null, response: boolean) => void
	): boolean;
	requestMaster(
		type: 'deleteKey',
		data: { key: string },
		callback?: (err: Error | null, response: boolean) => void
	): boolean;
	requestMaster(
		type: 'getKeys',
		data: void,
		callback?: (err: Error | null, response: string[]) => void
	): boolean;
	requestWorker(
		worker: Worker,
		type: string | symbol,
		data?: unknown,
		callback?: Hub.Callback
	): boolean;
	requestWorker(
		worker: Worker,
		type: 'ping',
		data?: unknown,
		callback?: (err: Error | null, reponse: 'pong') => void
	): boolean;
	on(eventName: string | symbol, listener: (...args: unknown[]) => void): this;
	on(
		event: 'ping',
		callback: (
			data: void,
			sender: Worker,
			callback: (err: Error | null, data?: 'pong') => void
		) => void
	): void;
	on(
		event: 'getKey',
		callback: (
			data: { key: string },
			sender: Worker,
			callback: (err: Error | null, data?: string | void) => void
		) => void
	): void;
	on(
		event: 'hasKey',
		callback: (
			data: { key: string },
			sender: Worker,
			callback: (err: Error | null, data?: boolean) => void
		) => void
	): void;
	on(
		event: 'deleteKey',
		callback: (
			data: { key: string },
			sender: Worker,
			callback: (err: Error | null, data?: boolean) => void
		) => void
	): void;
	on(
		event: 'setKey',
		callback: (
			data: { key: string; value: string },
			sender: Worker,
			callback: (err: Error | null, data?: string | void) => void
		) => void
	): void;
	on(
		event: 'getKeys',
		callback: (
			data: void,
			sender: Worker,
			callback: (err: Error | null, data?: string[]) => void
		) => void
	): void;
}

function createWorker(env: unknown) {
	const worker = cluster.fork(env);

	return new Promise<Worker>((resolve, reject) => {
		const cleanup = () => {
			worker.off('error', onError);
			worker.off('online', onOnline);
		};

		const onError = (err: Error) => {
			cleanup();
			reject(err);
		};

		const onOnline = () => {
			cleanup();
			resolve(worker);
		};

		worker.on('error', onError);
		worker.on('online', onOnline);
	});
}

function workerExit(worker: Worker) {
	return new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			worker.off('error', onError);
			worker.off('exit', onExit);
		};

		const onError = (err: Error) => {
			cleanup();
			reject(err);
		};

		const onExit = () => {
			cleanup();
			resolve();
		};

		worker.on('error', onError);
		worker.on('exit', onExit);
	});
}

interface ClusterData {
	directory: string;
	host?: string;
	port: number;
	config: ServerConfig;
}

if (cluster.isWorker) {
	const data = JSON.parse(process.env.BARE!) as ClusterData;
	const bareServer = createBareServer(data.directory, data.config, {
		get: (key) =>
			new Promise<string | void>((resolve, reject) =>
				hub.requestMaster('getKey', { key }, (err, data) => {
					if (err) reject(err);
					else resolve(data);
				})
			),
		has: (key) =>
			new Promise<boolean>((resolve, reject) =>
				hub.requestMaster('hasKey', { key }, (err, data) => {
					if (err) reject(err);
					else resolve(data);
				})
			),
		set: (key, value) =>
			new Promise<void>((resolve, reject) =>
				hub.requestMaster('setKey', { key, value }, (err) => {
					if (err) reject(err);
					else resolve();
				})
			),
		keys: () =>
			new Promise<string[]>((resolve, reject) =>
				hub.requestMaster('getKeys', undefined, (err, data) => {
					if (err) reject(err);
					else resolve(data);
				})
			),
		delete: (key) =>
			new Promise<boolean>((resolve, reject) =>
				hub.requestMaster('deleteKey', { key }, (err, data) => {
					if (err) reject(err);
					else resolve(data);
				})
			),
	});

	hub.on('ping', (data, sender, callback) => {
		callback(null, 'pong');
	});

	const httpServer = http.createServer();

	httpServer.on('request', (req, res) => {
		if (bareServer.shouldRoute(req)) {
			bareServer.routeRequest(req, res);
		} else {
			res.writeHead(400);
			res.end('Not found.');
		}
	});

	httpServer.on('upgrade', (req, socket, head) => {
		if (bareServer.shouldRoute(req)) {
			bareServer.routeUpgrade(req, socket, head);
		} else {
			socket.end();
		}
	});

	httpServer.listen({
		host: data.host,
		port: data.port,
	});
} else {
	const database = new MemoryDatabase();

	hub.on('getKey', ({ key }, sender, callback) => {
		callback(null, database.get(key));
	});

	hub.on('setKey', ({ key, value }, sender, callback) => {
		callback(null, database.set(key, value));
	});

	hub.on('getKeys', (data, sender, callback) => {
		callback(null, database.keys());
	});

	hub.on('hasKey', ({ key }, sender, callback) => {
		callback(null, database.has(key));
	});

	hub.on('deleteKey', ({ key }, sender, callback) => {
		callback(null, database.delete(key));
	});

	config();

	const program = new Command();

	program
		.alias('server')
		.option('-d, --directory <directory>', 'Bare directory', '/')
		.option(
			'-h, --host <host>',
			'Listening host',
			process.env.HOST || '0.0.0.0'
		)
		.option<number>(
			'-p, --port <port>',
			'Listening port',
			(val: string) => {
				const valN = Number(val);
				if (isNaN(valN)) throw new Error('Bad port');
				return valN;
			},
			process.env.PORT ? Number(process.env.PORT) : 80
		)
		.option('-e, --errors', 'Error logging', 'ERRORS' in process.env)
		.option(
			'-la, --local-address <address>',
			'Address/network interface',
			process.env.LOCAL_ADDRESS
		)
		.option(
			'-m, --maintainer <{email?:string,website?:string}>',
			'Bare Server maintainer field'
		)
		.action(
			({
				directory,
				errors,
				host,
				port,
				localAddress,
				maintainer,
			}: {
				directory: string;
				errors: boolean;
				host: string;
				port: number;
				localAddress?: string;
				maintainer?: string;
			}) => {
				const data: ClusterData = {
					directory,
					host,
					port,
					config: {
						logErrors: errors,
						localAddress,
						maintainer:
							typeof maintainer === 'string'
								? JSON.parse(maintainer)
								: undefined,
					},
				};

				const bareWorker = async (i: number) => {
					const badge = `[${i}]`;

					while (true) {
						const worker = await createWorker({
							BARE: JSON.stringify(data),
						});

						let msgTimeout: NodeJS.Timeout | void;

						const interval = setInterval(async () => {
							msgTimeout = setTimeout(() => {
								console.error(badge, 'Timed out');
								worker.destroy();
							}, 3e3);

							const res = await new Promise<string | void>((resolve, reject) =>
								hub.requestWorker(worker, 'ping', undefined, (err, data) => {
									if (err) reject(err);
									else resolve(data);
								})
							);

							if (res !== 'pong') throw new Error('Unknown');
							clearTimeout(msgTimeout);
						}, 5e3);

						await workerExit(worker);
						clearInterval(interval);
						if (msgTimeout) clearTimeout(msgTimeout);

						console.error(badge, 'Exited');
					}
				};

				const numCPUs = cpus().length;

				for (let i = 0; i < numCPUs; i++) bareWorker(i);

				console.log('Running on', numCPUs, 'threads');

				console.table({
					'Error Logging': errors,
					URL: `http://${
						host === '0.0.0.0' ? 'localhost' : host
					}:${port}${directory}`,
				});
			}
		);

	program.parse(process.argv);
}
