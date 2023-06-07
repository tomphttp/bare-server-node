import type { BareRemote } from './remoteUtil';
import type { BareHeaders } from './requestUtil';

export interface BareV1Meta {
	remote: BareRemote;
	headers: BareHeaders;
	forward_headers: string[];
	id?: string;
}

export interface BareV1MetaRes {
	headers: BareHeaders;
}
