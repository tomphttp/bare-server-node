import './sourceMap.js';
import { pkg } from './BareServer.js';
import createBareServer from './createServer.js';
import exitHook from 'async-exit-hook';
import { Command } from 'commander';
import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

config();

const program = new Command();

program
	.alias('server')
	.version(pkg.version)
	.option('-d, --directory <directory>', 'Bare directory', '/')
	.option('-h, --host <host>', 'Listening host', process.env.HOST || '0.0.0.0')
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
		'-f, --family <4|6>',
		'IP address family used when looking up host/hostnames.',
		process.env.IP_FAMILY
	)
	.option(
		'-m, --maintainer <{email?:string,website?:string}>',
		'Inline maintainer data'
	)
	.option(
		'-mf, --maintainer-file <string>',
		'Path to a file containing the maintainer data'
	)
	.action(
		async ({
			directory,
			errors,
			host,
			port,
			localAddress,
			family,
			maintainer,
			maintainerFile,
		}: {
			directory: string;
			errors: boolean;
			host: string;
			port: number;
			localAddress?: string;
			family?: number;
			maintainer?: string;
			maintainerFile?: string;
		}) => {
			const config = {
				logErrors: errors,
				localAddress,
				family,
				maintainer: maintainer
					? JSON.parse(maintainer)
					: maintainerFile
					? JSON.parse(await readFile(maintainerFile, 'utf-8'))
					: undefined,
			};
			const bareServer = createBareServer(directory, config);

			console.log('Error Logging:', errors);
			console.log(
				'URL:          ',
				`http://${host === '0.0.0.0' ? 'localhost' : host}${
					port === 80 ? '' : `:${port}`
				}${directory}`
			);
			console.log('Maintainer:   ', config.maintainer);

			const server = createServer();

			server.on('request', (req, res) => {
				if (bareServer.shouldRoute(req)) {
					bareServer.routeRequest(req, res);
				} else {
					res.writeHead(400);
					res.end('Not found.');
				}
			});

			server.on('upgrade', (req, socket, head) => {
				if (bareServer.shouldRoute(req)) {
					bareServer.routeUpgrade(req, socket, head);
				} else {
					socket.end();
				}
			});

			server.listen({
				host: host,
				port: port,
			});

			exitHook(() => {
				bareServer.close();
				server.close();
			});
		}
	);

program.parse(process.argv);
