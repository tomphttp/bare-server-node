import { Server as BareServer } from './Server.mjs';
import { Server as HTTPServer } from 'node:http';
import { program, Option } from 'commander';

program
.addOption(new Option('--d, --directory <string>', 'Bare directory').default('/'))
.addOption(new Option('--h, --host <string>', 'Listening host').default('localhost'))
.addOption(new Option('--p, --port <number>', 'Listening port').default(80).env('PORT'))
.addOption(new Option('--e, --errors', 'Error logging').default(false))
;

program.parse(process.argv);

const options = program.opts();

const bare = new BareServer(options.directory, options.errors);
console.info('Created Bare Server on directory:', options.directory);
console.info('Error logging is', options.errors ? 'enabled.' : 'disabled.');

const http = new HTTPServer();
console.info('Created HTTP server.');

http.on('request', (req, res) => {
	if(bare.route_request(req, res))return;

	res.writeHead(400);
	res.send('Not found');
});

http.on('upgrade', (req, socket, head) => {
	if(bare.route_upgrade(req, socket, head))return;
	socket.end();
});

http.on('listening', () => {
	console.log(`HTTP server listening. View live at https://${options.host}:${options.port}${options.directory}`);
});

http.listen({
	host: options.host,
	port: options.port,
});