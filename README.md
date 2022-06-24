# TOMP Bare Server

This repository implements the TompHTTP bare server. See the specification [here](https://github.com/tomphttp/specifications/blob/master/BareServer.md).

## Usage

We provide a command-line interface for creating a server.

For more features, specify the `--help` option when running the CLI.

## Quickstart

1. Install Bare Server Node globally

```sh
npm install --global @tomphttp/bare-server-node
```

2. Start the server

```sh
npx bare-server-node
```

Optionally start the server localhost:8080

```sh
npx bare-server-node --port 8080 --host localhost
```

## Programically create a bare server

```js
import { createServer as createHttpServer } from 'http';
import createBareServer from '@tomphttp/bare-sever-node';

const httpServer = createHttpServer();

const bareServer = createBareServer('/', {
	logErrors: false,
	localAddress: undefined,
	maintainer: {
		email: 'tomphttp@sys32.dev',
		website: 'https://github.com/tomphttp/',
	},
});

bareServer.on('request', (req, res) => {
	if(server.)
});


httpServer.on('request', (req, res) => {
	if (bareServer.shouldRoute(req)) {
		bareServer.routeRequest(req, res);
	} else {
		res.writeHead(400);
		res.send('Not found.');
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
```
