import 'source-map-support/register.js';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import exitHook from 'async-exit-hook';
import { Command } from 'commander';
import { config } from 'dotenv';
import { pkg } from './BareServer.js';
import type { BareServerInit, IPFamily } from './createServer.js';
import { createBareServer } from './createServer.js';

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
		process.env.PORT ? Number(process.env.PORT) : 80,
	)
	.option('-e, --errors', 'Error logging', 'ERRORS' in process.env)
	.option(
		'-la, --local-address <address>',
		'Address/network interface',
		process.env.LOCAL_ADDRESS,
	)
	.option<number>(
		'-f, --family <0|4|6>',
		'IP address family used when looking up host/hostnames. Default is 0',
		(val: string) => {
			const valN = Number(val);
			if (isNaN(valN)) throw new Error('Bad family');
			return valN;
		},
		process.env.IP_FAMILY ? Number(process.env.IP_FAMILY) : 0,
	)
	.option(
		'-nbl, --no-block-local',
		'When set, local IP addresses/DNS records are NOT blocked.',
	)
	.option(
		'-m, --maintainer <{email?:string,website?:string}>',
		'Inline maintainer data',
	)
	.option(
		'-mf, --maintainer-file <string>',
		'Path to a file containing the maintainer data',
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
			blockLocal,
		}: {
			directory: string;
			errors: boolean;
			host: string;
			port: number;
			localAddress?: string;
			family?: number;
			maintainer?: string;
			maintainerFile?: string;
			blockLocal?: boolean;
		}) => {
			const config: BareServerInit = {
				logErrors: errors,
				localAddress,
				family: family as IPFamily,
				blockLocal,
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
				}${directory}`,
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
		},
	);

program.parse(process.argv);
