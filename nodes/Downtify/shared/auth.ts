/**
 * Credential authentication: Device Token or Username & Password.
 *
 * With Username & Password, n8n calls the credential's preAuthentication when the stored device
 * token is empty, after a 401 and on every credential test. It signs in once with
 * POST /api/auth/token and n8n stores the device token in the hidden `sessionToken` field.
 * `sessionTokenFingerprint` ties that token to the Base URL, username and password it was issued
 * for, so a token is never sent to another server or reused for another user.
 */
import type { ICredentialDataDecryptedObject, IDataObject, IHttpRequestHelper, IHttpRequestOptions } from 'n8n-workflow';

import { describeNetworkError, errorDetail, readBody } from './response';
import { hasControlChars, normalizeBaseUrl, redactString, stateKey, validateToken } from './security';

export type AuthMode = 'deviceToken' | 'password';

export const SIGN_IN_PATH = '/api/auth/token';

/** Device name and platform shown by Downtify under Settings > Apps. */
export const DEVICE_NAME = 'n8n';

const SIGN_IN_TIMEOUT_MS = 30_000;

const SIGN_IN_MAX_BYTES = 1024 * 1024;

const MAX_USERNAME_LENGTH = 64;

const MAX_PASSWORD_LENGTH = 1024;

/** Device token format of Downtify (auth.py). */
export const DEVICE_TOKEN_RE = /^dtfy_[a-z2-9]{12}_[A-Za-z0-9_-]{32,64}$/;

/** Sign-in failure: message and description never contain the password or a token. */
export class DowntifySignInError extends Error {
	readonly description?: string;

	readonly downtifySignIn = true;

	constructor(message: string, description?: string) {
		super(message);
		this.name = 'DowntifySignInError';
		this.description = description;
	}
}

/** The sign-in error carried by `error` or by its cause (n8n wraps it in a NodeApiError). */
export function findSignInError(error: unknown): DowntifySignInError | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
		if ((current as { downtifySignIn?: unknown }).downtifySignIn === true) return current as DowntifySignInError;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

export function authMode(raw: ICredentialDataDecryptedObject): AuthMode {
	return raw.authentication === 'deviceToken' ? 'deviceToken' : 'password';
}

function username(raw: ICredentialDataDecryptedObject): string {
	return typeof raw.username === 'string' ? raw.username.trim() : '';
}

function password(raw: ICredentialDataDecryptedObject): string {
	return typeof raw.password === 'string' ? raw.password : '';
}

/** The password, for redaction only. */
export function credentialPassword(raw: ICredentialDataDecryptedObject): string {
	return authMode(raw) === 'password' ? password(raw) : '';
}

/**
 * The token is part of the input: a fast hash of the password alone could be brute-forced by
 * anyone who sees the stored fingerprint.
 */
export function sessionTokenFingerprint(baseUrl: string, user: string, pass: string, token: string): string {
	const input = `${token}\n${baseUrl}\n${user}\n${pass}`;
	return `v2.${stateKey(input)}.${stateKey(`${input}\n${token}`)}`;
}

/**
 * Token to send as Bearer. Device Token: the token entered by the user. Username & Password: the
 * stored session token, only if it was issued for this Base URL, username and password (else
 * none, so Downtify answers 401 and n8n signs in again).
 */
export function credentialToken(raw: ICredentialDataDecryptedObject): string {
	if (authMode(raw) === 'deviceToken') return validateToken(raw.deviceToken);
	const token = typeof raw.sessionToken === 'string' ? raw.sessionToken.trim() : '';
	if (!DEVICE_TOKEN_RE.test(token)) return '';
	let baseUrl: string;
	try {
		baseUrl = normalizeBaseUrl(raw.baseUrl);
	} catch {
		return '';
	}
	return raw.sessionTokenFingerprint === sessionTokenFingerprint(baseUrl, username(raw), password(raw), token) ? token : '';
}

interface SignInResponse {
	statusCode: number;
	data: unknown;
	retryAfter: string;
}

/** A clean sign-in error for a failed request, built without any field of the original error. */
function networkFailure(error: unknown, secrets: string[]): DowntifySignInError {
	const e = error as { code?: string; message?: string; cause?: { code?: string } };
	const raw = `${e?.code ?? ''} ${e?.cause?.code ?? ''} ${e?.message ?? ''}`;
	if (/ERR_RESPONSE_TOO_LARGE|maximum allowed size|maxContentLength/i.test(raw)) {
		return new DowntifySignInError('Sign-in to Downtify failed: the response is too large');
	}
	if (/ECONNABORTED|ETIMEDOUT|timeout of \d+ms exceeded/i.test(raw)) {
		return new DowntifySignInError(`Sign-in to Downtify timed out after ${SIGN_IN_TIMEOUT_MS / 1000} s`);
	}
	const { message, description } = describeNetworkError(error, false);
	return new DowntifySignInError(
		redactString(`Sign-in to Downtify failed: ${message}`, secrets),
		description ? redactString(description, secrets) : undefined,
	);
}

async function call(
	helpers: IHttpRequestHelper['helpers'],
	options: IHttpRequestOptions,
	secrets: string[],
): Promise<SignInResponse> {
	let response: { body?: unknown; statusCode?: number; headers?: IDataObject } | undefined;
	let failure: DowntifySignInError | undefined;
	try {
		response = (await helpers.httpRequest({
			...options,
			encoding: 'arraybuffer',
			json: false,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			disableFollowRedirect: true,
			sendCredentialsOnCrossOriginRedirect: false,
			timeout: SIGN_IN_TIMEOUT_MS,
			maxResponseBodyBytes: SIGN_IN_MAX_BYTES,
		})) as typeof response;
	} catch (error) {
		// Never rethrow the original error: it holds the request, with the password in its body
		failure = networkFailure(error, secrets);
	}
	if (failure || !response) throw failure ?? new DowntifySignInError('Sign-in to Downtify failed: no response');
	const statusCode = Number(response?.statusCode ?? 0);
	if (statusCode >= 300 && statusCode < 400) {
		throw new DowntifySignInError(
			`Sign-in to Downtify failed: the server answered with a redirect (HTTP ${statusCode}). Redirects are never followed.`,
			'Check that the Base URL points directly to Downtify (scheme, host, port and path prefix).',
		);
	}
	let data: unknown;
	try {
		const text = readBody(response?.body, SIGN_IN_MAX_BYTES);
		data = text.trim() === '' ? undefined : JSON.parse(text);
	} catch {
		data = undefined;
	}
	const headers = response?.headers ?? {};
	return { statusCode, data, retryAfter: String(headers['retry-after'] ?? '').slice(0, 16) };
}

function signInFailure(res: SignInResponse, secrets: string[]): DowntifySignInError {
	const detail = redactString(errorDetail(res.data), secrets).slice(0, 500);
	const suffix = detail ? `: ${detail}` : '';
	switch (res.statusCode) {
		case 401:
			return new DowntifySignInError(
				`Downtify rejected the username or password (401)${suffix}`,
				'Check Username and Password. After several wrong attempts Downtify blocks sign-in from this address for a while.',
			);
		case 404:
			return new DowntifySignInError(
				`Sign-in endpoint not found (404)${suffix}`,
				'Check the Base URL (path prefix of a reverse proxy) and that the server runs Downtify 3.8 or later.',
			);
		case 409:
			return new DowntifySignInError(
				`Downtify refused the sign-in (409)${suffix}`,
				'Password sign-in is turned off on this server: use Device Token authentication (with an empty token if DOWNTIFY_DISABLE_AUTH=true).',
			);
		case 429:
			return new DowntifySignInError(
				`Too many sign-in attempts (429)${suffix}`,
				res.retryAfter ? `Downtify asks to wait ${res.retryAfter} s before trying again.` : 'Wait before trying again.',
			);
		default:
			return new DowntifySignInError(`Sign-in to Downtify failed (HTTP ${res.statusCode})${suffix}`);
	}
}

/** Keeps the stored token while Downtify accepts it, so a credential test adds no device. */
export async function preAuthenticate(
	helpers: IHttpRequestHelper['helpers'],
	raw: ICredentialDataDecryptedObject,
): Promise<IDataObject> {
	if (authMode(raw) !== 'password') return {};
	let baseUrl = '';
	let invalidUrl = '';
	try {
		baseUrl = normalizeBaseUrl(raw.baseUrl);
	} catch (error) {
		invalidUrl = (error as Error).message;
	}
	if (invalidUrl) throw new DowntifySignInError(invalidUrl);
	const user = username(raw);
	const pass = password(raw);
	if (user === '' || pass === '') {
		throw new DowntifySignInError('Username and Password are required for Username & Password authentication');
	}
	if (user.length > MAX_USERNAME_LENGTH || hasControlChars(user)) {
		throw new DowntifySignInError('Username is too long or contains control characters');
	}
	if (pass.length > MAX_PASSWORD_LENGTH) throw new DowntifySignInError('Password is too long');

	const saved = credentialToken(raw);
	const secrets = [pass, saved].filter((s) => s !== '');

	if (saved !== '') {
		const me = await call(
			helpers,
			{ method: 'GET', url: `${baseUrl}/api/me`, headers: { Accept: 'application/json', Authorization: `Bearer ${saved}` } },
			secrets,
		);
		// Sign in again only when Downtify no longer accepts the token. Any other answer (server
		// error, wrong path...) is reported by the request itself instead of adding a device.
		if (me.statusCode !== 401) return { sessionToken: saved, sessionTokenFingerprint: sessionTokenFingerprint(baseUrl, user, pass, saved) };
	}

	const res = await call(
		helpers,
		{
			method: 'POST',
			url: `${baseUrl}${SIGN_IN_PATH}`,
			headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: user, password: pass, device_name: DEVICE_NAME, platform: DEVICE_NAME }),
		},
		secrets,
	);
	if (res.statusCode < 200 || res.statusCode >= 300) throw signInFailure(res, secrets);
	const token = (res.data as IDataObject | undefined)?.token;
	if (typeof token !== 'string' || !DEVICE_TOKEN_RE.test(token)) {
		throw new DowntifySignInError(
			'Sign-in to Downtify failed: the answer contains no device token',
			'Check that the Base URL points to Downtify 3.8 or later.',
		);
	}
	return { sessionToken: token, sessionTokenFingerprint: sessionTokenFingerprint(baseUrl, user, pass, token) };
}
