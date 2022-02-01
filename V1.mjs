import http, { request } from 'http';
import https from 'https';
import { MapHeaderNamesFromArray, RawHeaderNames } from './HeaderUtil.mjs';
import { decode_protocol } from './EncodeProtocol.mjs';
import { Response } from './Response.mjs';

// max of 4 concurrent sockets, rest is queued while busy? set max to 75
// const http_agent = http.Agent();
// const https_agent = https.Agent();

async function Fetch(server_request, request_headers, url){
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
			if(url.protocol === 'https:')request_stream = https.request(options, resolve);
			else if(url.protocol === 'http:')request_stream = http.request(options, resolve);
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

function load_forwarded_headers(request, forward, target){
	const raw = RawHeaderNames(request.rawHeaders);

	for(let header of forward){
		for(let cap of raw){
			if(cap.toLowerCase() == header){
				// header exists and real capitalization was found
				target[cap] = request.headers[header];
			}
		}
	}
}

function read_headers(server_request, request_headers){
	const remote = Object.setPrototypeOf({}, null);
	const headers = Object.setPrototypeOf({}, null);
	
	for(let remote_prop of ['host','port','protocol','path']){
		const header = `x-bare-${remote_prop}`;

		if(header in request_headers){
			let value = request_headers[header];
			
			if(remote_prop === 'port'){
				value = parseInt(value);
				if(isNaN(value))return { error: `${header} was not a valid integer.` };
			}

			remote[remote_prop] = value;
		}else{
			return { error: `${header} (remote.${remote_prop} was not specified.` };
		}
	}
	
	if('x-bare-headers' in request_headers){
		let json;
		
		try{
			json = JSON.parse(request_headers['x-bare-headers']);
		}catch(err){
			return { error: `x-bare-forward-headers contained invalid JSON.` }
		}

		Object.assign(headers, json);
	}else{
		return { error: `x-bare-headers was not specified.` };
	}

	if('x-bare-forward-headers' in request_headers){
		let json;
		
		try{
			json = JSON.parse(request_headers['x-bare-forward-headers']);
		}catch(err){
			return { error: `x-bare-forward-headers contained invalid JSON.` }
		}

		load_forwarded_headers(server_request, json, headers);
		
		for(let header of json){
			if(header in headers){
				headers[header] = request_headers[header];
			}
		}
	}else{
		return { error: `x-bare-forward-headers was not specified.` };
	}

	return { remote, headers };
}

export async function v1(server_request){
	const response_headers = Object.setPrototypeOf({}, null);

	response_headers['x-robots-tag'] = 'noindex';
	response_headers['access-control-allow-headers'] = '*';
	response_headers['access-control-allow-origin'] = '*';
	response_headers['access-control-expose-headers'] = '*';
	
	const { error, remote, headers } = read_headers(server_request, server_request.headers);
	
	if(error){
		// sent by browser, not client
		if(server_request.method === 'OPTIONS'){
			return new Response(undefined, 200, response_headers);
		}else{
			throw new TypeError(error);
		}
	}

	let response;

	try{
		response = await Fetch(server_request, headers, remote);
	}catch(err){
		console.error(err, remote);
		throw err;
	}

	for(let header in response.headers){
		if(header === 'content-encoding' || header === 'x-content-encoding'){
			response_headers['content-encoding'] = response.headers[header];
		}else if(header === 'content-length'){
			response_headers['content-length'] = response.headers[header];
		}
	}

	response_headers['x-bare-headers'] = JSON.stringify(MapHeaderNamesFromArray(RawHeaderNames(response.rawHeaders), {...response.headers}));
	response_headers['x-bare-status'] = response.statusCode
	response_headers['x-bare-status-text'] = response.statusMessage;

	return new Response(response, 200, response_headers);
}

export async function v1socket(server, server_request, server_socket, server_head){
	if(!server_request.headers['sec-websocket-protocol']){
		return socket.end();
	}

	const [ first_protocol, data ] = server_request.headers['sec-websocket-protocol'].split(/,\s*/g);
	
	const {
		remote,
		headers,
		protocol,
		forward_headers,
	} = JSON.parse(decode_protocol(data));
	
	load_forwarded_headers(server_request, forward_headers, headers);

	const options = {
		...remote,
		headers,
		method: server_request.method,	
	};
	
	let request_stream;
	
	let response_promise = new Promise((resolve, reject) => {
		try{
			if(protocol === 'wss:')request_stream = https.request(options, res => reject(`Remote didn't upgrade the request`));
			else if(protocol === 'ws:')request_stream = http.request(options, res => reject(`Remote didn't upgrade the request`));
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
	
	const response_headers = [
		'HTTP/1.1 101 Switching Protocols',
		'Upgrade: websocket',
		'Connection: Upgrade',
		'Sec-WebSocket-Accept: ' + response.headers['sec-websocket-accept'],
		'Sec-WebSocket-Protocol: ' + first_protocol,
	].concat('', '').join('\r\n');

	server_socket.write(response_headers);
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