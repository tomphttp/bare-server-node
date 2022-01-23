import http, { request } from 'http';
import https from 'https';
import { MapHeaderNamesFromArray, RawHeaderNames } from './HeaderUtil.mjs';
import { decode_protocol } from './EncodeProtocol.mjs';

// max of 4 concurrent sockets, rest is queued while busy? set max to 75
// const http_agent = http.Agent();
// const https_agent = https.Agent();

export async function Fetch(server_request, request_headers, url){
	const options = {
		host: url.host,
		port: url.port,
		path: url.path,
		method: server_request.method,
		headers: request_headers,
	};
	
	let request_stream;
	
	let response_promise = new Promise((resolve, reject) => {
		try{
			if(url.protocol == 'https:')request_stream = https.request(options, resolve);
			else if(url.protocol == 'http:')request_stream = http.request(options, resolve);
			else return reject(new RangeError(`Unsupported protocol: '${url.protocol}'`));
			
			request_stream.on('error', reject);
		}catch(err){
			reject(err);
		}
	});

	if(request_stream){
		server_request.pipe(request_stream);
	}
	
	return await response_promise;
}

const forward = ['accept-encoding', 'accept-language'];

export async function SendBare(server, server_request, server_response){
	const request_headers = Object.setPrototypeOf({}, null);
	const response_headers = Object.setPrototypeOf({}, null);

	response_headers['x-robots-tag'] = 'noindex';
	response_headers['access-control-allow-headers'] = '*';
	response_headers['access-control-allow-origin'] = '*';
	response_headers['access-control-expose-headers'] = '*';
	
	if(server_request.method == 'OPTIONS'){
		server_response.writeHead(200, response_headers);
		return void server_response.end();
	}

	if('x-tomp-headers' in server_request.headers){
		const json = JSON.parse(server_request.headers['x-tomp-headers']);
		Object.assign(request_headers, json);
	}

	for(let header in server_request.headers){
		if(forward.includes(header)){
			request_headers[header] = server_request.headers[header];
		}
	}
	
	const search = new URLSearchParams(server_request.url.slice(server_request.url.indexOf('?')));
	const url = {
		host: server_request.headers['x-tomp-host'],
		path: server_request.headers['x-tomp-path'],
		port: parseInt(server_request.headers['x-tomp-port']),
		protocol: server_request.headers['x-tomp-protocol'],
	};

	for(let prop in url){
		if(url[prop] == undefined || url[prop] == NaN){
			return void server.send_json(server_response, 400, {
				message: `One or more URL fields was invalid.`
			});
		}
	}

	try{
		var response = await Fetch(server_request, request_headers, url);
	}catch(err){
		console.error(err, url);
		throw err;
	}

	for(let header in response.headers){
		if(header == 'content-encoding' || header == 'x-content-encoding'){
			response_headers['content-encoding'] = response.headers[header];
		}else if(header == 'content-length'){
			response_headers['content-length'] = response.headers[header];
		}
	}

	response_headers['x-tomp-headers'] = JSON.stringify(MapHeaderNamesFromArray(RawHeaderNames(response.rawHeaders), {...response.headers}));
	response_headers['x-tomp-status'] = response.statusCode
	response_headers['x-tomp-status-text'] = response.statusMessage;

	server_response.writeHead(200, response_headers);
	response.pipe(server_response);
}

export async function SendSocket(server, server_request, server_socket, server_head){
	if(!server_request.headers['sec-websocket-protocol'])socket.end();
	const protocols = server_request.headers['sec-websocket-protocol'].split(/,\s*/g);
	const a_protocol = protocols[0]; // for sec-websocket-protocol in response IF the remote hasnt specified a protocol
	let [request_headers,protocol,host,port,path] = protocols.splice(0, 5).map(decode_protocol);
	
	port = parseInt(port);
	request_headers = Object.setPrototypeOf(JSON.parse(request_headers), null);
		
	for(let header in server_request.headers){
		if(header.startsWith('accept') || header.startsWith('sec-websocket-') && header != 'sec-websocket-protocol'){
			request_headers[header] = server_request.headers[header];
		}
	}

	if(protocols.length){
		request_headers['sec-websocket-protocol'] = protocols.join(', ');
	}
	
	const options = {
		host,
		port,
		path,
		headers: MapHeaderNamesFromArray(RawHeaderNames(server_request.rawHeaders), Object.setPrototypeOf({...request_headers}, null)),
		method: server_request.method,	
	};
	
	let request_stream;
	
	let response_promise = new Promise((resolve, reject) => {
		try{
			if(protocol == 'wss:')request_stream = https.request(options, res => reject(`Remote didn't upgrade the request`));
			else if(protocol == 'ws:')request_stream = http.request(options, res => reject(`Remote didn't upgrade the request`));
			else return reject(new RangeError(`Unsupported protocol: '${protocol}'`));
			
			request_stream.on('upgrade', (...args) => resolve(args))
			request_stream.on('error', reject);
			request_stream.write(server_head);
			request_stream.end();
		}catch(err){
			reject(err);
		}
	});

	const [ response, socket, head ] = await response_promise;
	
	const response_headers = Object.setPrototypeOf({...response.headers}, null);

	if(!('sec-webSocket-protocol' in response_headers)){
		response_headers['sec-websocket-protocol'] = a_protocol;
	}

	const response_headers_mapped = MapHeaderNamesFromArray(RawHeaderNames(response.rawHeaders), response_headers);

	let handshake = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
	
	for (let header in response_headers_mapped) {
		handshake += `${header}: ${response_headers_mapped[header]}\r\n`;
	}

	handshake += '\r\n';
	
	server_socket.write(handshake);
	server_socket.write(head);

	socket.on('close', () => {
		console.log('Remote closed');
		server_socket.end();
	});

	server_socket.on('close', () => {
		console.log('Serving closed');
		socket.end();
	});

	socket.on('error', err => {
		console.error('Remote socket error:', err);
		server_socket.end();
	});
	
	server_socket.on('error', err => {
		console.error('Serving socket error:', err);
		socket.end();
	});

	socket.pipe(server_socket);
	server_socket.pipe(socket);
}