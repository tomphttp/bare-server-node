import { Command } from 'commander';
import { config } from 'dotenv';
import { Server as HTTPServer } from 'node:http';
import BareServer from './Server.js';

config();

const program = new Command();

program
	.alias('server')
	.option('--d, --directory <directory>', 'Bare directory', '/')
	.option(
		'--h, --host <host>',
		'Listening host',
		process.env.HOST || 'localhost'
	)
	.option('--p, --port <port>', 'Listening port', process.env.PORT || 80)
	.option('--e, --errors', 'Error logging', 'ERRORS' in process.env)
	.option(
		'--la, --local-address <address>',
		'Address/network interface',
		process.env.LOCAL_ADDRESS
	)
	.action(({ directory, errors, host, port, localAddress }) => {
		const bare = new BareServer(directory, errors, localAddress);
		console.info('Created Bare Server on directory:', directory);
		console.info('Error logging is', errors ? 'enabled.' : 'disabled.');

		const http = new HTTPServer();
		console.info('Created HTTP server.');

		http.on('request', (req, res) => {
			if (bare.route_request(req, res)) return;

			res.writeHead(400);
			res.send('Not found');
		});

		http.on('upgrade', (req, socket, head) => {
			if (bare.route_upgrade(req, socket, head)) return;
			socket.end();
		});

		http.on('listening', () => {
			console.log(
				`HTTP server listening. View live at http://${host}:${port}${directory}`
			);
		});

		http.listen({
			host: host,
			port: port,
		});
	});

program.parse(process.argv);
