import {
	NodeOperationError,
	sleep,
	type ICredentialDataDecryptedObject,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestMethods,
	type IHttpRequestOptions,
	type ILoadOptionsFunctions,
	type INode,
	type IPollFunctions,
} from 'n8n-workflow';

import {
	MAX_RESPONSE_BYTES,
	normalizeBaseUrl,
	redactString,
	redactValue,
	REQUEST_TIMEOUT_MS,
	SecurityError,
	validateToken,
} from './security';

export const CREDENTIAL_NAME = 'downtifyApi';

export type DowntifyContext = IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions;

export type DowntifyMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface DowntifyRequestOptions {
	/** Query string parameters. */
	qs?: IDataObject;
	/** JSON body (POST, PUT, PATCH, DELETE). */
	body?: unknown;
	/** Timeout in ms (default 60 s). */
	timeoutMs?: number;
	/** Maximum response size in bytes. */
	maxBytes?: number;
	/** HTTP status codes returned to the caller instead of raising an error. */
	acceptStatus?: number[];
}

export interface DowntifyCredentials {
	baseUrl: string;
	token: string;
}

export interface DowntifyResponse<T = unknown> {
	statusCode: number;
	data: T;
}

interface RawResponse {
	statusCode: number;
	statusMessage: string;
	text: string;
}

export function parseCredentials(raw: ICredentialDataDecryptedObject): DowntifyCredentials {
	return {
		baseUrl: normalizeBaseUrl(raw.baseUrl),
		token: validateToken(raw.deviceToken),
	};
}

/** Decodes the (already buffered) response body; the size is checked again as a safety net. */
function readBody(body: unknown, maxBytes: number): string {
	if (body === undefined || body === null) return '';
	if (typeof body === 'string') {
		if (Buffer.byteLength(body) > maxBytes) throw new SecurityError('Response too large');
		return body;
	}
	if (Buffer.isBuffer(body) || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
		const buf = Buffer.isBuffer(body)
			? body
			: body instanceof ArrayBuffer
				? Buffer.from(body)
				: Buffer.from(body.buffer, body.byteOffset, body.byteLength);
		if (buf.length > maxBytes) throw new SecurityError('Response too large');
		return buf.toString('utf8');
	}
	return JSON.stringify(body);
}

function tooLargeMessage(maxBytes: number): string {
	return `Response too large (more than ${Math.round(maxBytes / 1024 / 1024)} MiB), aborted`;
}

function describeNetworkError(error: unknown): { message: string; description?: string } {
	const e = error as {
		code?: string;
		message?: string;
		description?: string;
		cause?: { code?: string; message?: string; cause?: { code?: string; message?: string } };
		context?: { data?: { code?: string } };
	};
	const haystack = [
		e?.code,
		e?.cause?.code,
		e?.cause?.cause?.code,
		e?.context?.data?.code,
		e?.message,
		e?.description,
		e?.cause?.message,
		e?.cause?.cause?.message,
	]
		.filter((x) => typeof x === 'string')
		.join(' ');
	if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|certificate|ERR_TLS_CERT/i.test(haystack)) {
		return {
			message: 'TLS certificate of the Downtify server is not trusted (self-signed, expired or wrong host name)',
			description: 'Use a trusted certificate on the reverse proxy in front of Downtify.',
		};
	}
	if (/EPROTO|wrong version number|SSL routines|ERR_SSL/i.test(haystack)) {
		return {
			message: 'TLS handshake with the Downtify server failed',
			description: 'Check whether the Base URL should use http:// or https://.',
		};
	}
	if (/ECONNREFUSED/.test(haystack)) return { message: 'Connection refused by the Downtify server', description: 'Check host and port of the Base URL.' };
	if (/ENOTFOUND|EAI_AGAIN/.test(haystack)) return { message: 'Downtify host not found', description: 'Check the host name of the Base URL.' };
	if (/ETIMEDOUT|ECONNABORTED|timeout/i.test(haystack)) return { message: 'Request to Downtify timed out' };
	if (/ECONNRESET|socket hang up/i.test(haystack)) return { message: 'Connection to Downtify was reset' };
	if (/cancel|abort/i.test(haystack)) return { message: 'Request to Downtify was cancelled' };
	return { message: 'Request to Downtify failed', description: typeof e?.message === 'string' ? e.message : undefined };
}

/** FastAPI error detail: a string, or a list of validation errors. */
export function errorDetail(body: unknown): string {
	if (!body || typeof body !== 'object') return '';
	const detail = (body as IDataObject).detail;
	if (typeof detail === 'string') return detail.trim();
	if (Array.isArray(detail)) {
		return detail
			.map((d) => {
				if (!d || typeof d !== 'object') return String(d);
				const loc = Array.isArray((d as IDataObject).loc) ? ((d as IDataObject).loc as unknown[]).join('.') : '';
				const msg = typeof (d as IDataObject).msg === 'string' ? ((d as IDataObject).msg as string) : JSON.stringify(d);
				return loc ? `${loc}: ${msg}` : msg;
			})
			.join('; ')
			.slice(0, 2000);
	}
	if (detail && typeof detail === 'object') return JSON.stringify(detail).slice(0, 2000);
	return '';
}

/**
 * HTTP client for one execution. Every request goes through
 * `helpers.httpRequestWithAuthentication` (the credential adds `Authorization: Bearer`)
 * with redirects disabled, a timeout and a response size limit.
 */
export class DowntifyClient {
	private readonly secrets: string[] = [];

	constructor(
		private readonly ctx: DowntifyContext,
		readonly credentials: DowntifyCredentials,
	) {
		if (credentials.token) this.secrets.push(credentials.token);
	}

	static async create(ctx: DowntifyContext): Promise<DowntifyClient> {
		const raw = await ctx.getCredentials(CREDENTIAL_NAME);
		try {
			return new DowntifyClient(ctx, parseCredentials(raw));
		} catch (error) {
			throw new NodeOperationError(ctx.getNode(), (error as Error).message);
		}
	}

	get node(): INode {
		return this.ctx.getNode();
	}

	redact(text: string): string {
		return redactString(text, this.secrets);
	}

	redactValue<T>(value: T): T {
		return redactValue(value, this.secrets);
	}

	error(message: string, description?: string): NodeOperationError {
		return new NodeOperationError(this.node, this.redact(message), {
			description: description ? this.redact(description) : undefined,
		});
	}

	async get<T = unknown>(path: string, qs?: IDataObject, opts: DowntifyRequestOptions = {}): Promise<T> {
		return (await this.request<T>('GET', path, { ...opts, qs })).data;
	}

	async post<T = unknown>(path: string, body?: unknown, opts: DowntifyRequestOptions = {}): Promise<T> {
		return (await this.request<T>('POST', path, { ...opts, body })).data;
	}

	/** Performs a request and returns the status code and the parsed JSON body. */
	async request<T = unknown>(
		method: DowntifyMethod,
		path: string,
		opts: DowntifyRequestOptions = {},
	): Promise<DowntifyResponse<T>> {
		this.assertInternalPath(path);
		this.throwIfCancelled();
		const res = await this.send(method, path, opts);
		return this.handleResponse<T>(res, opts.acceptStatus ?? []);
	}

	private assertInternalPath(path: string): void {
		if (
			!path.startsWith('/') ||
			path.startsWith('//') ||
			/[?#\\\s]/.test(path) ||
			path.split('/').some((s) => s === '.' || s === '..')
		) {
			throw this.error('Invalid API path');
		}
	}

	private async send(method: DowntifyMethod, path: string, opts: DowntifyRequestOptions): Promise<RawResponse> {
		const headers: IDataObject = { Accept: 'application/json' };
		const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
		const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
		// The response is buffered by n8n. This bounds the request without any timer of ours
		// (n8n 2.45 replaces a node-supplied abortSignal with the execution cancel signal):
		// - `timeout`: n8n closes the connection when the server sends nothing for timeoutMs;
		// - `maxResponseBodyBytes`: n8n closes the connection as soon as the body exceeds the limit.
		const options: IHttpRequestOptions = {
			method: method as IHttpRequestMethods,
			url: `${this.credentials.baseUrl}${path}`,
			headers,
			encoding: 'arraybuffer',
			maxResponseBodyBytes: maxBytes,
			json: false,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			disableFollowRedirect: true,
			sendCredentialsOnCrossOriginRedirect: false,
			timeout: timeoutMs,
			arrayFormat: 'repeat',
		};
		if (opts.qs) {
			const qs: IDataObject = {};
			for (const [k, v] of Object.entries(opts.qs)) {
				if (v === undefined || v === null || v === '') continue;
				qs[k] = typeof v === 'boolean' ? (v ? 'true' : 'false') : (v as string);
			}
			if (Object.keys(qs).length) options.qs = qs;
		}
		if (method !== 'GET' && opts.body !== undefined) {
			headers['Content-Type'] = 'application/json';
			options.body = JSON.stringify(opts.body);
		}

		let response: { body?: unknown; statusCode?: number; statusMessage?: string };
		try {
			response = (await this.ctx.helpers.httpRequestWithAuthentication.call(
				this.ctx,
				CREDENTIAL_NAME,
				options,
			)) as typeof response;
		} catch (error) {
			const e = error as { code?: string; message?: string; cause?: { code?: string; message?: string } };
			const detail = `${e?.code ?? ''} ${e?.cause?.code ?? ''} ${e?.message ?? ''} ${e?.cause?.message ?? ''}`;
			if (/ERR_RESPONSE_TOO_LARGE|maximum allowed size|maxContentLength/i.test(detail)) {
				throw this.error(tooLargeMessage(maxBytes));
			}
			if (this.isCancelled()) throw this.error('Execution was cancelled');
			if (/ECONNABORTED|ETIMEDOUT|timeout of \d+ms exceeded/i.test(detail)) {
				throw this.error(`Request to Downtify timed out after ${Math.round(timeoutMs / 1000)} s`);
			}
			const { message, description } = describeNetworkError(error);
			throw this.error(message, description);
		}
		const statusCode = Number(response?.statusCode ?? 0);
		if (statusCode >= 300 && statusCode < 400) {
			throw this.error(
				`The server answered with a redirect (HTTP ${statusCode}). Redirects are never followed.`,
				'Check that the Base URL points directly to Downtify (scheme, host, port and path prefix).',
			);
		}
		let text: string;
		try {
			text = readBody(response?.body, maxBytes);
		} catch {
			throw this.error(tooLargeMessage(maxBytes));
		}
		return { statusCode, statusMessage: String(response?.statusMessage ?? ''), text };
	}

	/** True when the user cancelled the execution. */
	isCancelled(): boolean {
		const getSignal = (this.ctx as { getExecutionCancelSignal?: () => AbortSignal | undefined })
			.getExecutionCancelSignal;
		return typeof getSignal === 'function' && getSignal.call(this.ctx)?.aborted === true;
	}

	throwIfCancelled(): void {
		if (this.isCancelled()) throw this.error('Execution was cancelled');
	}

	/** Waits between polls; stops early when the execution is cancelled. */
	async pause(ms: number): Promise<void> {
		this.throwIfCancelled();
		// Short slices, so a cancelled execution stops within a second
		let left = ms;
		while (left > 0) {
			const step = Math.min(left, 1000);
			await sleep(step);
			left -= step;
			this.throwIfCancelled();
		}
	}

	private handleResponse<T>(res: RawResponse, acceptStatus: number[]): DowntifyResponse<T> {
		let parsed: unknown;
		if (res.text.trim() !== '') {
			try {
				parsed = JSON.parse(res.text);
			} catch {
				parsed = undefined;
			}
		}
		const ok = res.statusCode >= 200 && res.statusCode < 300;
		if (!ok && !acceptStatus.includes(res.statusCode)) {
			const detail = errorDetail(parsed) || res.statusMessage.trim() || 'Request failed';
			let hint: string | undefined;
			if (res.statusCode === 401) {
				hint = this.credentials.token
					? 'The device token is wrong or was revoked (Settings > Apps in Downtify). Create a new one with POST /api/auth/token.'
					: 'This server requires a device token: set one in the credential.';
			} else if (res.statusCode === 403) {
				hint = 'A device token cannot use this endpoint: it needs a signed-in browser or an admin.';
			} else if (res.statusCode === 409) {
				hint = 'Downtify refused the request in its current state (for example library-only mode).';
			} else if (res.statusCode === 429) {
				hint = 'Too many requests: wait and try again.';
			}
			throw this.error(`Downtify API error ${res.statusCode}: ${detail}`, hint);
		}
		if (ok && parsed === undefined && res.text.trim() !== '') {
			throw this.error(
				'Invalid response from the server (not a Downtify JSON response)',
				'Check that the Base URL points to Downtify and not to another web page.',
			);
		}
		return { statusCode: res.statusCode, data: (parsed ?? null) as T };
	}
}
