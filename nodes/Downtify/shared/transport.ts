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

import { authMode, credentialPassword, credentialToken, findSignInError, type AuthMode } from './auth';
import { describeNetworkError, errorDetail, readBody, tooLargeMessage } from './response';
import { MAX_RESPONSE_BYTES, normalizeBaseUrl, redactString, redactValue, REQUEST_TIMEOUT_MS } from './security';

export const CREDENTIAL_NAME = 'downtifyApi';

export type DowntifyContext = IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions;

export type DowntifyMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface DowntifyRequestOptions {
	qs?: IDataObject;
	body?: unknown;
	/** Timeout in ms (default 60 s). */
	timeoutMs?: number;
	maxBytes?: number;
	/** HTTP status codes returned to the caller instead of raising an error. */
	acceptStatus?: number[];
}

export interface DowntifyCredentials {
	baseUrl: string;
	mode: AuthMode;
	/** Token sent as Bearer: the device token, or the stored session token (may be empty). */
	token: string;
	/** Password of Username & Password, kept only to redact it from error messages. */
	password: string;
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
		mode: authMode(raw),
		token: credentialToken(raw),
		password: credentialPassword(raw),
	};
}

/**
 * HTTP client for one execution. Every request goes through
 * `helpers.httpRequestWithAuthentication` (the credential adds `Authorization: Bearer`)
 * with redirects disabled, a timeout and a response size limit.
 */
export class DowntifyClient {
	/** Secret values removed from outputs and errors (tokens). */
	private readonly secrets: string[] = [];

	/** Also removed from error messages (the password). */
	private readonly errorSecrets: string[] = [];

	/** Username & Password: the session was renewed once in this execution. */
	private renewed = false;

	constructor(
		private readonly ctx: DowntifyContext,
		public credentials: DowntifyCredentials,
	) {
		this.addSecrets(credentials);
	}

	private addSecrets(credentials: DowntifyCredentials): void {
		if (credentials.token && !this.secrets.includes(credentials.token)) this.secrets.push(credentials.token);
		// Not used on outputs: the server never returns the password, and redacting a short
		// password there would corrupt ordinary data.
		if (credentials.password && !this.errorSecrets.includes(credentials.password)) {
			this.errorSecrets.push(credentials.password);
		}
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
		return redactString(text, [...this.secrets, ...this.errorSecrets]);
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

	async request<T = unknown>(
		method: DowntifyMethod,
		path: string,
		opts: DowntifyRequestOptions = {},
	): Promise<DowntifyResponse<T>> {
		this.assertInternalPath(path);
		this.throwIfCancelled();
		let res = await this.send(method, path, opts);
		if (res.statusCode === 401 && this.credentials.mode === 'password' && !this.renewed) {
			// Downtify no longer accepts the stored token (revoked, or issued for another server
			// or user): sign in again once, then repeat the request. A 401 is answered before
			// Downtify does anything, so repeating a POST is safe.
			this.renewed = true;
			await this.renewSession();
			res = await this.send(method, path, opts);
		}
		return this.handleResponse<T>(res, opts.acceptStatus ?? []);
	}

	/**
	 * n8n signs in again (preAuthentication) only when a request made through
	 * httpRequestWithAuthentication fails with 401. The node's own requests read every status
	 * code, so this cheap request (GET /api/me, which throws on 401) triggers it; n8n then stores
	 * the new device token in the credential.
	 */
	private async renewSession(): Promise<void> {
		try {
			await this.ctx.helpers.httpRequestWithAuthentication.call(this.ctx, CREDENTIAL_NAME, {
				method: 'GET',
				url: `${this.credentials.baseUrl}/api/me`,
				headers: { Accept: 'application/json' },
				encoding: 'arraybuffer',
				json: false,
				returnFullResponse: true,
				disableFollowRedirect: true,
				sendCredentialsOnCrossOriginRedirect: false,
				timeout: REQUEST_TIMEOUT_MS,
				maxResponseBodyBytes: 1024 * 1024,
			});
		} catch (error) {
			const signIn = findSignInError(error);
			if (signIn) throw this.error(signIn.message, signIn.description);
			if (this.isCancelled()) throw this.error('Execution was cancelled');
			const status = (error as { httpCode?: unknown }).httpCode;
			if (String(status) === '401') {
				throw this.error(
					'Downtify API error 401: the server still refuses the device token after signing in again',
					'Check that the Base URL points directly to Downtify and that no proxy in front of it asks for its own authentication.',
				);
			}
			const { message, description } = describeNetworkError(error, false);
			throw this.error(`Sign-in to Downtify failed: ${message}`, description);
		}
		try {
			const renewed = parseCredentials(await this.ctx.getCredentials(CREDENTIAL_NAME));
			this.addSecrets(renewed);
			this.credentials = renewed;
		} catch (error) {
			throw this.error((error as Error).message);
		}
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
			const signIn = findSignInError(error);
			if (signIn) throw this.error(signIn.message, signIn.description);
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

	isCancelled(): boolean {
		const getSignal = (this.ctx as { getExecutionCancelSignal?: () => AbortSignal | undefined })
			.getExecutionCancelSignal;
		return typeof getSignal === 'function' && getSignal.call(this.ctx)?.aborted === true;
	}

	throwIfCancelled(): void {
		if (this.isCancelled()) throw this.error('Execution was cancelled');
	}

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
				hint =
					this.credentials.mode === 'password'
						? 'Downtify refused the device token n8n received when signing in. Check the credential and Settings > Apps in Downtify.'
						: this.credentials.token
							? 'The device token is wrong or was revoked (Settings > Apps in Downtify). Create a new one, or use Username & Password.'
							: 'This server requires a device token: set one in the credential, or use Username & Password.';
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
