import http from 'node:http';
import https from 'node:https';
import Response from './Response.js';
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

const MAX_HEADER_VALUE = 2096;

// ,header,id
const split_header = /(x-bare-\w+)-(\d)/g;

function read_headers(server_request, request_headers){
	const remote = Object.setPrototypeOf({}, null);
	const headers = Object.setPrototypeOf({}, null);
	const pass_headers = ['content-encoding', 'content-length'];
	const pass_status = [];
	const join_headers = {};

	for(let header in request_headers){
		if(header.startsWith('x-bare-')){
			const value = request_headers[header];

			if(value.length > MAX_HEADER_VALUE){
				return {
					error: {
						code: 'INVALID_BARE_HEADER',
						id: `request.headers.${header}`,
						message: `Length for bare header exceeds the limit. (${value.length} > ${MAX_HEADER_VALUE})`,
					},
				};
			}

			const match = header.match(split_header);

			if(match){
				let [,target,id] = match;

				id = parseInt(id);

				if(isNaN(id) || id === 0){
					return {
						error: {
							code: 'INVALID_BARE_HEADER',
							id: `request.headers.${header}`,
							message: `Split ID was not a number or 0.`,
						},
					};
				}

				if(!(target in request_headers)){
					return {
						error: {
							code: 'INVALID_BARE_HEADER',
							id: `request.headers.${header}`,
							message: `Target header doesn't have an initial value.`,
						},
					};
				}

				if(!(target in join_headers)){
					join_headers[target] = [ request_headers[target] ];
				}

				join_headers[target][id] = value;

				delete request_headers[header];
			}

			for(let header in join_headers){
				request_headers[header] = join_headers.join('');
			}
		}
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
					id: `request.headers.${header}`,
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
		let json;
		
		try{
			json = JSON.parse(request_headers['x-bare-pass-headers']);
		}catch(err){
			return {
				error: {
					code: 'INVALID_BARE_HEADER',
					id: `request.headers.x-bare-pass-headers`,
					message: `Header contained invalid JSON. (${err.message})`,
				},
			};
		}

		for(let header of json){
			if(typeof header === 'string'){
				pass_headers.push(header.toLowerCase());
			}else{
				return {
					error: {
						code: 'INVALID_BARE_HEADER',
						id: `request.headers.x-bare-pass-headers`,
						message: `Array contained non-string value.`,
					},
				};
			}
		}
	}else{
		return {
			error: {
				code: 'MISSING_BARE_HEADER',
				id: `request.headers.x-bare-pass-headers`,
				message: `Header was not specified.`,
			},
		};
	}

	if('x-bare-pass-status' in request_headers){
		let json;
		
		try{
			json = JSON.parse(request_headers['x-bare-pass-status']);
		}catch(err){
			return {
				error: {
					code: 'INVALID_BARE_HEADER',
					id: `request.headers.x-bare-pass-status`,
					message: `Header contained invalid JSON. (${err.message})`,
				},
			};
		}

		for(let status of json){
			if(typeof status === 'number'){
				pass_status.push(status);
			}else{
				return {
					error: {
						code: 'INVALID_BARE_HEADER',
						id: `request.headers.x-bare-pass-status`,
						message: `Array contained non-string value.`,
					},
				};
			}
		}
	}else{
		return {
			error: {
				code: 'MISSING_BARE_HEADER',
				id: `request.headers.x-bare-pass-headers`,
				message: `Header was not specified.`,
			},
		};
	}

	if('x-bare-forward-headers' in request_headers){
		let json;
		
		try{
			json = JSON.parse(request_headers['x-bare-forward-headers']);
		}catch(err){
			return {
				error: {
					code: 'INVALID_BARE_HEADER',
					id: `request.headers.x-bare-forward-headers`,
					message: `Header contained invalid JSON. (${err.message})`,
				},
			};
		}

		load_forwarded_headers(server_request, json, headers);
	}else{
		return {
			error: {
				code: 'MISSING_BARE_HEADER',
				id: `request.headers.x-bare-forward-headers`,
				message: `Header was not specified.`,
			},
		};
	}

	return { remote, headers, pass_headers, pass_status };
}

async function request(server, server_request){
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

	for(let header of pass_headers){
		if(headers in response.headers){
			response_headers[header] = response.headers[header];
		}
	}

	response_headers['x-bare-headers'] = JSON.stringify(mapHeadersFromArray(rawHeaderNames(response.rawHeaders), {...response.headers}));
	response_headers['x-bare-status'] = response.statusCode
	response_headers['x-bare-status-text'] = response.statusMessage;

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
	const id = (await randomBytesAsync(32)).toString('hex');

	temp_meta[id] = {
		expires: Date.now() + 30e3,
	};
	
	return new Response(Buffer.from(id.toString('hex')))
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
	
	load_forwarded_headers(server_request, forward_headers, headers);

	const [ response, socket, head ] = await upgradeFetch(server, server_request, headers, remote);

	if(id in temp_meta){
		const meta = {
			headers: mapHeadersFromArray(rawHeaderNames(response.rawHeaders), {...response.headers}),
		};
		
		temp_meta[id].meta = meta;
	}

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