/**
 * Test harness: minimal IExecuteFunctions / IPollFunctions implementations.
 * HTTP requests go through the real n8n 2.45 request implementation (@n8n/backend-network
 * 1.19.0), after applying the credential's authenticate() exactly like n8n does.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
	NodeApiError,
	type ICredentialDataDecryptedObject,
	type IDataObject,
	type IHttpRequestOptions,
	type INode,
	type INodeExecutionData,
	type JsonObject,
} from 'n8n-workflow';

import { DowntifyApi } from '../../credentials/DowntifyApi.credentials';
import { Downtify } from '../../nodes/Downtify/Downtify.node';
import { DowntifyTrigger } from '../../nodes/DowntifyTrigger/DowntifyTrigger.node';
import { TOKEN, type FakeDowntify } from './fakeDowntify.mts';

const requireCjs = createRequire(import.meta.url);
const { httpRequest } = requireCjs(
	join(process.cwd(), 'node_modules', '@n8n', 'backend-network', 'dist', 'http', 'axios', 'request.js'),
) as { httpRequest: (o: IHttpRequestOptions) => Promise<unknown> };

export type Params = Record<string, unknown>;

export function credentials(server: { url: string }, extra: IDataObject = {}): ICredentialDataDecryptedObject {
	return { baseUrl: server.url, deviceToken: TOKEN, ...extra };
}

export const credentialType = new DowntifyApi();

export const sentRequests: IHttpRequestOptions[] = [];

/** Same flow as n8n-core: authenticate() then the outbound request; errors wrapped in NodeApiError. */
export async function httpRequestWithAuthentication(
	node: INode,
	creds: ICredentialDataDecryptedObject,
	options: IHttpRequestOptions,
): Promise<unknown> {
	const authenticate = credentialType.authenticate as (
		c: ICredentialDataDecryptedObject,
		o: IHttpRequestOptions,
	) => Promise<IHttpRequestOptions>;
	const authed = await authenticate(creds, { ...options });
	sentRequests.push(authed);
	try {
		return await httpRequest(authed);
	} catch (error) {
		throw new NodeApiError(node, error as JsonObject);
	}
}

export { httpRequest };

function getParam(params: Params, name: string, fallback: unknown): unknown {
	return name in params ? params[name] : fallback;
}

export const NODE: INode = {
	id: 'node-1',
	name: 'Downtify',
	type: 'n8n-nodes-downtify.downtify',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

export interface RunOptions {
	credentials: ICredentialDataDecryptedObject;
	params: Params | Params[];
	items?: INodeExecutionData[];
	continueOnFail?: boolean;
	/** Simulates the execution cancel signal of n8n. */
	cancelSignal?: AbortSignal;
}

export async function runNode(opts: RunOptions): Promise<INodeExecutionData[]> {
	const items = opts.items ?? (Array.isArray(opts.params) ? opts.params.map(() => ({ json: {} })) : [{ json: {} }]);
	const paramsFor = (i: number): Params => (Array.isArray(opts.params) ? (opts.params[i] ?? {}) : opts.params);
	const ctx = {
		getInputData: () => items,
		getNode: () => NODE,
		getCredentials: async () => opts.credentials,
		continueOnFail: () => opts.continueOnFail === true,
		getExecutionCancelSignal: () => opts.cancelSignal,
		getNodeParameter: (name: string, i: number, fallback?: unknown) => getParam(paramsFor(i), name, fallback),
		helpers: {
			httpRequestWithAuthentication: async function (_type: string, o: IHttpRequestOptions) {
				// Like n8n-core 2.45: a node-supplied abortSignal is replaced by the execution cancel signal
				return await httpRequestWithAuthentication(NODE, opts.credentials, { ...o, abortSignal: opts.cancelSignal });
			},
		},
	};
	const result = await new Downtify().execute.call(ctx as never);
	return result[0];
}

export async function runNodeJson(opts: RunOptions): Promise<IDataObject[]> {
	return (await runNode(opts)).map((i) => i.json);
}

/** Runs the node and returns the error it throws. */
export async function runNodeError(opts: RunOptions): Promise<Error & { description?: string }> {
	return await runNode(opts).then(
		() => {
			throw new Error('expected an error');
		},
		(e: Error & { description?: string }) => e,
	);
}

export interface PollOptions {
	credentials: ICredentialDataDecryptedObject;
	params: Params;
	mode?: 'manual' | 'trigger';
	staticData: IDataObject;
}

export async function poll(opts: PollOptions): Promise<IDataObject[] | null> {
	const ctx = {
		getNode: () => ({ ...NODE, name: 'Downtify Trigger', type: 'n8n-nodes-downtify.downtifyTrigger' }),
		getMode: () => opts.mode ?? 'trigger',
		getCredentials: async () => opts.credentials,
		getWorkflowStaticData: () => opts.staticData,
		getNodeParameter: (name: string, fallback?: unknown) => getParam(opts.params, name, fallback),
		helpers: {
			httpRequestWithAuthentication: async function (_type: string, o: IHttpRequestOptions) {
				return await httpRequestWithAuthentication(NODE, opts.credentials, o);
			},
		},
	};
	const result = await new DowntifyTrigger().poll.call(ctx as never);
	return result ? result[0].map((i) => i.json) : null;
}

/** Evaluates an n8n "={{ ... }}" expression of the credential test with $credentials. */
export function evalCredentialExpression(expr: unknown, creds: ICredentialDataDecryptedObject): unknown {
	if (typeof expr !== 'string' || !expr.startsWith('={{')) return expr;
	const code = expr.slice(3, -2);
	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	return new Function('$credentials', `return (${code});`)(creds);
}

export type { FakeDowntify };
