import type { BareHeaders } from './requestUtil.js';

export type SocketClientToServer = {
	type: 'connect';
	/**
	 * Remote to connect to
	 */
	remote: string;
	/**
	 * An array of protocols to attempt to connect to.
	 */
	protocols: string[];
	/**
	 * Headers to send to the remote. Usually Cookie, Origin, and User-Agent.
	 */
	headers: BareHeaders;
	/**
	 * Forwards to forward from the WebSocket handshake (eg. User-Agent)
	 */
	forwardHeaders: string[];
};

export type SocketServerToClient = {
	type: 'open';
	/**
	 * The protocl that the remote chose.
	 */
	protocol: string;
	/**
	 * A list of cookies that correspond to the remote's set-cookies
	 */
	setCookies: string[];
};
