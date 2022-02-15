import zlib from 'node:zlib';

export async function DecompressStream(stream, encoding){
	// For Node v6+
	// Be less strict when decoding compressed responses, since sometimes
	// servers send slightly invalid responses that are still accepted
	// by common browsers.
	// Always using Z_SYNC_FLUSH is what cURL does.
	const zlib_opts = {
		flush: zlib.constants.Z_SYNC_FLUSH,
		finishFlush: zlib.constants.Z_SYNC_FLUSH
	};

	switch(encoding){
		case'deflate':
		case'x-deflate':
			return await new Promise(resolve => stream.once('data', chunk => {
				const piped = stream.pipe((chunk[0] & 0x0F) === 0x08 ? zlib.createInflate() : zlib.createInflateRaw());
				resolve(ReadStream(piped));
			}));
			
			break;
		case'gzip':
		case'x-gzip':
			stream = stream.pipe(zlib.createGunzip(zlib_opts));
			
			break;
		case'br':
			stream = stream.pipe(zlib.createBrotliDecompress());
				
			break;
	}
	
	return await ReadStream(stream);
}

export async function DecompressResponse(response){
	// if(request.method != 'HEAD' && res.statusCode != 204  && res.statusCode != 304)switch(res.headers['content-encoding'] || res.headers['x-content-encoding']){

	if(response.statusCode == 204 || response.statusCode == 304) return Buffer.alloc(0);

	return await DecompressStream(response, response.headers['content-encoding'] || response.headers['x-content-encoding']);
}


export async function ReadStream(stream){
	return await new Promise((resolve, reject) => {
		const chunks = [];

		stream.on('data', chunk => chunks.push(chunk));

		stream.on('end', () => {
			resolve(Buffer.concat(chunks));
		});

		stream.on('error', reject);
	});
}

export async function DecodePOSTStream(stream, type){
	const decoded = {};

	Object.setPrototypeOf(decoded, null);

	const body = await ReadStream(stream);
	
	try{
		switch(type){
			case'application/x-www-form-urlencoded':
				Object.assign(decoded, Object.fromEntries([...new URLSearchParams(body.toString()).entries()]));
				break;
			case'application/json':
				Object.assign(decoded, JSON.parse(body));
				break;
		}
	}catch(err){
		console.error(err);
		// error is only caused by intentionally bad body
	}
	
	return decoded
}