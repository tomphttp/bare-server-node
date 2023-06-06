import type { BareHeaders } from './BareTypes';
import type { BareRemote } from './remoteUtil';

export interface BareV1Meta {
	remote: BareRemote;
	headers: BareHeaders;
	forward_headers: string[];
	id?: string;
}

export interface BareV1MetaRes {
	headers: BareHeaders;
}
