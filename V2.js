import http from 'node:http';
import https from 'node:https';
import Response, { Headers } from './Response.js';
import { split_headers, join_headers } from './splitHeaderUtil.js';
import { mapHeadersFromArray, rawHeaderNames } from './headerUtil.js';
import { decodeProtocol } from './encodeProtocol.js';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const randomBytesAsync = promisify(randomBytes);

// max of 4 concurrent sockets, rest is queued while busy? set max to 75

const http_agent = http.Agent({
	keepAlive: true,
});

const https_agent = https.Agent({
	keepAlive: true,
});

async function fetch(server, server_request, request_headers, url){
	const options = {
		host: url.host,
		port: url.port,
		path: url.path,
		method: server_request.method,
		headers: request_headers,
		setHost: false,
		localAddress: server.local_address,
	};
	
	let outgoing;

	if(url.protocol === 'https:'){
		outgoing = https.request({ ...options, agent: https_agent });
	}else if(url.protocol === 'http:'){
		outgoing = http.request({ ...options, agent: http_agent });
	}else{
		throw new RangeError(`Unsupported protocol: '${url.protocol}'`);
	}
	
	server_request.pipe(outgoing);
	
	return await new Promise((resolve, reject) => {
		outgoing.on('response', resolve);
		outgoing.on('error', reject);	
	});
}

async function upgradeFetch(server, server_request, request_headers, url){
	const options = {
		host: url.host,
		port: url.port,
		path: url.path,
		headers: request_headers,
		method: server_request.method,
		setHost: false,
		localAddress: server.local_address,
	};
	
	let outgoing;

	if(url.protocol === 'wss:'){
		outgoing = https.request({ ...options, agent: https_agent });
	}else if(url.protocol === 'ws:'){
		outgoing = http.request({ ...options, agent: http_agent });
	}else{
		throw new RangeError(`Unsupported protocol: '${url.protocol}'`);
	}

	outgoing.end();
	
	return await new Promise((resolve, reject) => {
		outgoing.on('response', () => {
			reject('Remote upgraded the WebSocket');
		});

		outgoing.on('upgrade', (...args) => {
			resolve(args);
		});

		outgoing.on('error', error => {
			reject(error);
		});
	});
}

function load_forwarded_headers(request, forward, target){
	const raw = rawHeaderNames(request.rawHeaders);

	for(let header of forward){
		for(let cap of raw){
			if(cap.toLowerCase() == header){
				// header exists and real capitalization was found
				target[cap] = request.headers[header];
			}
		}
	}
}

const split_header_value = /,\s+?/g;

function read_headers(server_request, request_headers){
	const remote = Object.setPrototypeOf({}, null);
	const headers = Object.setPrototypeOf({}, null);
	const pass_headers = ['content-encoding', 'content-length'];
	const pass_status = [];

	const { error } = join_headers(request_headers);

	if(error){
		return { error };
	}

	for(let remote_prop of ['host','port','protocol','path']){
		const header = `x-bare-${remote_prop}`;

		if(header in request_headers){
			let value = request_headers[header];
			
			if(remote_prop === 'port'){
				value = parseInt(value);
				if(isNaN(value)){
					return {
						error: {
							code: 'INVALID_BARE_HEADER',
							id: `request.headers.${header}`,
							message: `Header was not a valid integer.`,
						},
					};
				}
			}

			remote[remote_prop] = value;
		}else{
			return {
				error: {
					code: 'MISSING_BARE_HEADER',
					id: `request.headers.${header}`,
					message: `Header was not specified.`,
				},
			};
		}
	}
	
	if('x-bare-headers' in request_headers){
		let json;
		
		try{
			json = JSON.parse(request_headers['x-bare-headers']);

			for(let header in json){
				if(typeof json[header] !== 'string' && !Array.isArray(json[header])){
					return {
						error: {
							code: 'INVALID_BARE_HEADER',
							id: `bare.headers.${header}`,
							message: `Header was not a String or Array.`,
						},
					};
				}
			}
		}catch(err){
			return {
				error: {
					code: 'INVALID_BARE_HEADER',
					id: `request.headers.x-bare-headers`,
					message: `Header contained invalid JSON. (${err.message})`,
				},
			};
		}

		Object.assign(headers, json);
	}else{
		return {
			error: {
				code: 'MISSING_BARE_HEADER',
				id: `request.headers.x-bare-headers`,
				message: `Header was not specified.`,
			},
		};
	}

	if('x-bare-pass-headers' in request_headers){
		const parsed = request_headers['x-bare-pass-headers'].split(split_header_value);

		for(let header of parsed){
			pass_headers.push(header.toLowerCase());
		}
	}

	if('x-bare-pass-status' in request_headers){
		const parsed = request_headers['x-bare-pass-status'].split(split_header_value);

		for(let value of parsed){
			const number = parseInt(value);

			if(isNaN(number)){
				return {
					error: {
						code: 'INVALID_BARE_HEADER',
						id: `request.headers.x-bare-pass-status`,
						message: `Array contained non-string value.`,
					},
				};
			}else{
				pass_status.push(number);
			}
		}
	}

	if('x-bare-forward-headers' in request_headers){
		const parsed = request_headers['x-bare-forward-headers'].split(split_header_value);

		load_forwarded_headers(server_request, parsed, headers);
	}

	return { remote, headers, pass_headers, pass_status };
}

async function request(server, server_request){
	const { error, remote, headers, pass_headers, pass_status } = read_headers(server_request, server_request.headers);

	if(error){
		// sent by browser, not client
		if(server_request.method === 'OPTIONS'){
			return new Response(undefined, 200);
		}else{
			return server.json(400, error);
		}
	}

	let response;

	try{
		response = await fetch(server, server_request, headers, remote);
	}catch(err){
		if(err instanceof Error){
			switch(err.code){
				case'ENOTFOUND':
					return server.json(500, {
						code: 'HOST_NOT_FOUND',
						id: 'request',
						message: 'The specified host could not be resolved.',
					});
				case'ECONNREFUSED':
					return server.json(500, {
						code: 'CONNECTION_REFUSED',
						id: 'response',
						message: 'The remote rejected the request.',
					});
				case'ECONNRESET':
					return server.json(500, {
						code: 'CONNECTION_RESET',
						id: 'response',
						message: 'The request was forcibly closed.',
					});
				case'ETIMEOUT':
					return server.json(500, {
						code: 'CONNECTION_TIMEOUT',
						id: 'response',
						message: 'The response timed out.',
					});
			}
		}

		throw err;
	}

	const response_headers = new Headers();
	
	for(let header of pass_headers){
		if(header in response.headers){
			response_headers.set(header, response.headers[header]);
		}
	}

	const stringified = JSON.stringify(mapHeadersFromArray(rawHeaderNames(response.rawHeaders), {...response.headers}));

	response_headers.set('x-bare-headers', stringified);
	response_headers.set('x-bare-status', response.statusCode);
	response_headers.set('x-bare-status-text', response.statusMessage);

	// if(will_split_header(x_bare_headers)){
	// for(let [header,value] of split_header(x_bare_headers, 'x-bare-headers')){
	//  header - x-bare-headers-0
	//	value  - ;value
	//	response_headers.set(header, value);
	//	}
	// }
	// split_headers(response_headers);

	let status;

	if(pass_status.includes(response.statusCode)){
		status = response.statusCode;
	}else{
		status = 200;
	}

	return new Response(response, status, response_headers);
}

// prevent users from specifying id=__proto__ or id=constructor
const temp_meta = Object.setPrototypeOf({}, null);

setInterval(() => {
	for(let id in temp_meta){
		if(temp_meta[id].expires < Date.now()){
			delete temp_meta[id];
		}
	}
}, 1e3);

async function get_meta(server, server_request){
	if(server_request.method === 'OPTIONS'){
		return new Response(undefined, 200);
	}
	
	if(!('x-bare-id' in server_request.headers)){
		return server.json(400, {
			code: 'MISSING_BARE_HEADER',
			id: 'request.headers.x-bare-id',
			message: 'Header was not specified',
		});
	}

	const id = server_request.headers['x-bare-id'];

	if(!(id in temp_meta)){
		return server.json(400, {
			code: 'INVALID_BARE_HEADER',
			id: 'request.headers.x-bare-id',
			message: 'Unregistered ID',
		});
	}

	const { meta } = temp_meta[id];

	if(typeof meta === 'undefined'){
		return server.json(200, null);
	}

	delete temp_meta[id];

	return server.json(200, meta);
}

async function new_meta(server, server_request){
	const response_headers = Object.setPrototypeOf({}, null);

	const { error, remote, headers, pass_headers, pass_status } = read_headers(server_request, server_request.headers);

	if(error){
		// sent by browser, not client
		if(server_request.method === 'OPTIONS'){
			return new Response(undefined, 200, response_headers);
		}else{
			return server.json(400, error);
		}
	}
	
	const id = (await randomBytesAsync(32)).toString('hex');

	temp_meta[id] = {
		expires: Date.now() + 30e3,
		remote,
		headers,
	};
	
	return new Response(Buffer.from(id))
}

async function socket(server, server_request, server_socket, server_head){
	if(!server_request.headers['sec-websocket-protocol']){
		server_socket.end();
		return;
	}

	const [ first_protocol, data ] = server_request.headers['sec-websocket-protocol'].split(/,\s*/g);
	
	if(first_protocol !== 'bare'){
		server_socket.end();
		return;
	}

	const id = decodeProtocol(data);

	if(!(id in temp_meta)){
		socket.close();
	}

	const meta = temp_meta[id];
	
	meta.headers = mapHeadersFromArray(rawHeaderNames(response.rawHeaders), {...response.headers});

	const [ response, socket, head ] = await upgradeFetch(server, server_request, meta.headers, meta.remote);

	const response_headers = [
		`HTTP/1.1 101 Switching Protocols`,
		`Upgrade: websocket`,
		`Connection: Upgrade`,
		`Sec-WebSocket-Protocol: bare`,
		`Sec-WebSocket-Accept: ${response.headers['sec-websocket-accept']}`,
	];

	if('sec-websocket-extensions' in response.headers){
		response_headers.push(`Sec-WebSocket-Extensions: ${response.headers['sec-websocket-extensions']}`);
	}

	server_socket.write(response_headers.concat('', '').join('\r\n'));
	server_socket.write(head);

	socket.on('close', () => {
		// console.log('Remote closed');
		server_socket.end();
	});

	server_socket.on('close', () => {
		// console.log('Serving closed');
		socket.end();
	});

	socket.on('error', err => {
		server.error('Remote socket error:', err);
		server_socket.end();
	});
	
	server_socket.on('error', err => {
		server.error('Serving socket error:', err);
		socket.end();
	});

	socket.pipe(server_socket);
	server_socket.pipe(socket);
}

export default function register(server){
	server.routes.set('/v2/', request);
	server.routes.set('/v2/ws-new-meta', new_meta);
	server.routes.set('/v2/ws-meta', get_meta);
	server.socket_routes.set('/v2/', socket);
}