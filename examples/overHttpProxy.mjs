import http from 'node:http';
import { createBareServer } from '@tomphttp/bare-server-node';
import HttpsProxyAgent from 'https-proxy-agent';

const httpProxyAgent = new HttpsProxyAgent('http://168.63.76.32:3128');

const httpServer = http.createServer();

const bareServer = createBareServer('/', {
	httpAgent: httpProxyAgent,
	httpsAgent: httpProxyAgent,
});

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

httpServer.on('listening', () => {
	console.log('HTTP server listening');
});

httpServer.listen({
	port: 8080,
});
