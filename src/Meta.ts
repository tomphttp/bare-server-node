import type { BareHeaders, BareRemote } from './requestUtil';

export interface MetaV1 {
	v: 1;
	response?: {
		headers: BareHeaders;
	};
}

export interface MetaV2 {
	v: 2;
	response?: { status: number; statusText: string; headers: BareHeaders };
	sendHeaders: BareHeaders;
	remote: BareRemote;
	forwardHeaders: string[];
}

export default interface CommonMeta {
	value: MetaV1 | MetaV2;
	expires: number;
}
