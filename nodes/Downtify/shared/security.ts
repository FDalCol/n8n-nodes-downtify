/**
 * Security helpers: base URL validation, API path validation, the device-token route policy
 * and secret redaction.
 *
 * Every value that crosses into a request URL, an error message or an output item goes
 * through one of these functions.
 */

/** Default timeout for a single API request (ms). */
export const REQUEST_TIMEOUT_MS = 60_000;
/** Timeout for requests that ask Downtify to fetch a playlist or album from a provider (ms). */
export const RESOLVE_TIMEOUT_MS = 180_000;
/** Maximum accepted size of an API response body (bytes). */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Maximum number of polling iterations for any wait loop (hard stop). */
export const MAX_POLL_ITERATIONS = 100_000;
/** Maximum wait time for any wait loop (seconds): 24 hours. */
export const MAX_WAIT_SECONDS = 24 * 60 * 60;
/** Minimum polling interval for any wait loop (seconds). */
export const MIN_POLL_INTERVAL_SECONDS = 1;
/** Maximum polling interval for any wait loop (seconds). */
export const MAX_POLL_INTERVAL_SECONDS = 3600;
/** Maximum number of entries kept in trigger state. */
export const MAX_STATE_ENTRIES = 10_000;
/** Maximum number of entries returned by a list operation. */
export const MAX_LIST_ENTRIES = 100_000;
/** Maximum number of tracks queued by one Download URL operation. */
export const MAX_TRACKS_PER_REQUEST = 10_000;
/** Maximum number of retry rounds for failed tracks. */
export const MAX_RETRY_ROUNDS = 5;

export class SecurityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SecurityError';
	}
}

/**
 * Validates the base URL from the credential:
 * - http:// or https:// only
 * - no embedded credentials, query string or fragment
 * - trailing slashes removed
 * - an optional path prefix (reverse proxy) is kept, but must not contain traversal
 */
export function normalizeBaseUrl(raw: unknown): string {
	if (typeof raw !== 'string' || raw.trim() === '') {
		throw new SecurityError('Base URL is required (e.g. http://downtify.local:8000)');
	}
	const trimmed = raw.trim().replace(/\/+$/, '');
	if (!URL.canParse(trimmed)) {
		throw new SecurityError('Base URL is not a valid URL (e.g. http://downtify.local:8000)');
	}
	const parsed = new URL(trimmed);
	const protocol = parsed.protocol.toLowerCase();
	if (protocol !== 'https:' && protocol !== 'http:') {
		throw new SecurityError('Base URL must start with http:// or https://');
	}
	if (parsed.username !== '' || parsed.password !== '' || /^[a-z]+:\/\/[^/]*@/i.test(trimmed)) {
		throw new SecurityError('Base URL must not contain credentials');
	}
	if (parsed.search !== '' || trimmed.includes('?')) {
		throw new SecurityError('Base URL must not contain a query string');
	}
	if (parsed.hash !== '' || trimmed.includes('#')) {
		throw new SecurityError('Base URL must not contain a fragment');
	}
	const path = parsed.pathname.replace(/\/+$/, '');
	// The URL parser resolves "/a/../b" itself: the typed path is checked too
	const typedPath = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
	if (
		[path, typedPath].some((p) => p.split('/').some((s) => s === '..' || s === '.')) ||
		/%2e|%2f|%5c|\\/i.test(path + typedPath)
	) {
		throw new SecurityError('Base URL path is not allowed');
	}
	if (/\/api(\/|$)/i.test(path)) {
		throw new SecurityError('Base URL must be the server address, without /api');
	}
	return `${protocol}//${parsed.host}${path}`;
}

/** True when the string contains ASCII control characters (0-31, 127). */
export function hasControlChars(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c < 32 || c === 127) return true;
	}
	return false;
}

/**
 * Validates the device token. Empty is allowed (servers with DOWNTIFY_DISABLE_AUTH).
 * The token travels only in the Authorization header, so only printable ASCII is accepted.
 */
export function validateToken(raw: unknown): string {
	const token = typeof raw === 'string' ? raw.trim() : '';
	if (token === '') return '';
	if (token.length > 512 || !/^[\x21-\x7e]+$/.test(token)) {
		throw new SecurityError('Device Token contains invalid characters');
	}
	return token;
}

/** Names that must never be used as parameter or object keys (prototype pollution). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True for a safe parameter name: not empty, not __proto__/constructor/prototype. */
export function isSafeKey(key: string): boolean {
	return key !== '' && !FORBIDDEN_KEYS.has(key.toLowerCase());
}

/**
 * True when a value, read as a path, contains a "." or ".." segment (also "..;x"), either
 * literally or after one round of percent-decoding ("%2e%2e", "%2F" ...).
 */
export function hasTraversal(value: string): boolean {
	const variants = [value];
	try {
		variants.push(decodeURIComponent(value));
	} catch {
		// not valid percent-encoding: only the raw value can be interpreted
	}
	return variants.some((v) => v.split(/[/\\]/).some((part) => /^\.\.?(;.*)?$/.test(part)));
}

// ';' is not allowed: it is never needed by the API and enables "..;" tricks on some proxies.
const SAFE_PATH = /^[A-Za-z0-9\-._~:@!$&'()*+,=%/]*$/;

/**
 * Percent-escapes allowed in Custom API Call paths: printable ASCII only, never ".", "/", "\",
 * "%" (double encoding) or ";". Bytes >= 0x80 (e.g. overlong UTF-8 "%c0%ae") are rejected.
 */
function hasForbiddenEscape(path: string): boolean {
	for (const m of path.matchAll(/%([0-9a-f]{2})/gi)) {
		const code = parseInt(m[1], 16);
		if (code < 0x20 || code >= 0x7f || [0x25, 0x2e, 0x2f, 0x3b, 0x5c].includes(code)) return true;
	}
	return /%(?![0-9a-f]{2})/i.test(path);
}

/**
 * Validates a user supplied API path (Custom API Call). The path is relative to the Base URL.
 * Absolute URLs, traversal (also encoded), query strings, fragments, empty segments and
 * control characters are rejected. Returns the normalized path starting with "/".
 */
export function validateApiPath(raw: unknown): string {
	if (typeof raw !== 'string') throw new SecurityError('Path must be a string');
	let path = raw.trim();
	if (path === '') throw new SecurityError('Path is required');
	if (path.length > 2048) throw new SecurityError('Path is too long');
	if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
		throw new SecurityError('Absolute URLs are not allowed, use a path relative to the Base URL (e.g. /api/queue)');
	}
	if (hasControlChars(path) || /[\s\\]/.test(path)) {
		throw new SecurityError('Path contains forbidden characters');
	}
	if (path.includes('?') || path.includes('#')) {
		throw new SecurityError('Path must not contain a query string or fragment, use Query Parameters');
	}
	if (!SAFE_PATH.test(path)) throw new SecurityError('Path contains forbidden characters');
	if (hasForbiddenEscape(path)) {
		throw new SecurityError('Encoded path separators or traversal sequences are not allowed');
	}
	if (!path.startsWith('/')) path = `/${path}`;
	if (path.includes('//')) throw new SecurityError('Empty path segments are not allowed');
	for (const seg of path.split('/')) {
		if (/^\.\.?(;.*)?$/.test(seg)) throw new SecurityError('Path traversal is not allowed');
	}
	if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
	return path;
}

/**
 * Encodes a single path segment value (track ID, show ID ...). Rejects empty values and
 * anything that contains a "." / ".." path part, literally or percent-encoded.
 */
export function encodeSegment(value: unknown, label = 'value'): string {
	const str = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
	if (str === '') throw new SecurityError(`${label} is required`);
	if (str.length > 512) throw new SecurityError(`${label} is too long`);
	if (hasTraversal(str)) throw new SecurityError(`${label} is not valid`);
	if (hasControlChars(str)) throw new SecurityError(`${label} contains control characters`);
	return encodeURIComponent(str);
}

/** A positive integer ID (podcast shows and episodes, monitor playlists). */
export function validateIntegerId(value: unknown, label: string): number {
	const str = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
	if (!/^[1-9][0-9]{0,15}$/.test(str)) throw new SecurityError(`${label} must be a positive integer`);
	return Number(str);
}

/** A Deezer numeric ID (Finder artist IDs). */
export function validateDeezerId(value: unknown, label = 'Artist ID'): string {
	const str = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
	if (!/^[0-9]{1,20}$/.test(str)) throw new SecurityError(`${label} must be a numeric Deezer ID`);
	return str;
}

/** A link to resolve (Spotify, Deezer, YouTube Music, SoundCloud, RSS ...): http(s) only. */
export function validateLink(value: unknown, label = 'URL'): string {
	const str = typeof value === 'string' ? value.trim() : '';
	if (str === '') throw new SecurityError(`${label} is required`);
	if (str.length > 2048) throw new SecurityError(`${label} is too long`);
	if (hasControlChars(str) || !URL.canParse(str)) throw new SecurityError(`${label} is not a valid URL`);
	const protocol = new URL(str).protocol.toLowerCase();
	if (protocol !== 'https:' && protocol !== 'http:') {
		throw new SecurityError(`${label} must start with https://`);
	}
	return str;
}

/** A free text value sent as a query parameter. */
export function validateText(value: unknown, label: string, maxLength = 500, required = true): string {
	const str = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
	if (required && str === '') throw new SecurityError(`${label} is required`);
	if (str.length > maxLength) throw new SecurityError(`${label} is too long (maximum ${maxLength} characters)`);
	if (hasControlChars(str)) throw new SecurityError(`${label} contains control characters`);
	return str;
}

/** Validates an integer within a range (also values that come from expressions). */
export function validateInteger(value: unknown, label: string, min: number, max: number): number {
	const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
	if (!Number.isInteger(n) || n < min || n > max) {
		throw new SecurityError(`${label} must be an integer between ${min} and ${max}`);
	}
	return n;
}

// ---------------------------------------------------------------------------------------------
// Device token route policy (Downtify 3.8.1 downtify/auth.py RULES, same in 3.11.0)
// ---------------------------------------------------------------------------------------------

/** `signIn`: public sign-in and pairing routes, never sent by this node (they create devices). */
type Scope = 'public' | 'client' | 'user' | 'admin' | 'signIn';

const ALL = ['*'];
const READ = ['GET', 'HEAD'];

/** First match wins; anything inside the protected prefixes that matches nothing needs admin. */
const RULES: Array<[string[], RegExp, Scope]> = [
	[READ, /^\/api\/health$/, 'public'],
	[READ, /^\/api\/version$/, 'public'],
	[READ, /^\/api\/server\/info$/, 'public'],
	[READ, /^\/api\/auth\/status$/, 'public'],
	[READ, /^\/api\/auth\/oidc(\/callback)?$/, 'public'],
	[['POST'], /^\/api\/auth\/(login|logout|pair|token)$/, 'signIn'],
	[ALL, /^\/api\/auth\/(ws-ticket|pairing)/, 'signIn'],
	[READ, /^\/api\/me$/, 'client'],
	[ALL, /^\/api\/me(\/|$)/, 'user'],
	[ALL, /^\/api\/auth\/(devices|pairing)(\/|$)/, 'user'],
	[['DELETE'], /^\/(delete|delete\/batch)$/, 'user'],
	[ALL, /^\/api\/library\/playlist/, 'user'],
	[['POST'], /^\/api\/library\/archive/, 'user'],
	[READ, /^\/api\/library\/archive\//, 'user'],
	[['DELETE'], /^\/api\/queue/, 'user'],
	[['POST'], /^\/api\/likes\/clear$/, 'user'],
	[['POST'], /^\/api\/download\/csv$/, 'user'],
	[['POST'], /^\/api\/playlist\/m3u$/, 'user'],
	[['POST', 'DELETE'], /^\/api\/playlists\/(incomplete|batches)/, 'user'],
	[['DELETE'], /^\/api\/discover\/listens$/, 'user'],
	[['POST'], /^\/api\/podcasts\/subscribe$/, 'user'],
	[['PATCH', 'DELETE'], /^\/api\/podcasts\/shows\/\d+$/, 'user'],
	[['DELETE'], /^\/api\/podcasts\/episodes\/\d+$/, 'user'],
	[['POST', 'PATCH', 'DELETE'], /^\/api\/monitor\/playlists/, 'user'],
	[READ, /^\/api\/monitor\/(stats|provenance)$/, 'user'],
	[READ, /^\/api\/monitor\/playlists\/\d+\/(tracks|releases|releases\/tracks)$/, 'user'],
	[READ, /^\/api\/monitor\/artist-suggestions(\/resolve)?$/, 'user'],
	[READ, /^\/api\/monitor\/wanted(\/job)?$/, 'user'],
	[['POST'], /^\/api\/monitor\/wanted\//, 'user'],
	[ALL, /^\/api\/auth\//, 'admin'],
	[ALL, /^\/api\/server(\/port)?$/, 'admin'],
	[ALL, /^\/api\/settings/, 'admin'],
	[READ, /^\/api\/fs\/dirs$/, 'admin'],
	[ALL, /^\/api\/cookies$/, 'admin'],
	[ALL, /^\/api\/(slskd|navidrome|deemix|similar|proxy)\/test$/, 'admin'],
	[READ, /^\/api\/library\/summary$/, 'client'],
	[READ, /^\/api\/library\/loudness$/, 'client'],
	[ALL, /^\/api\/library\/loudness\//, 'admin'],
	[READ, /^\/api\/library\/(albums|artists)$/, 'client'],
	[['POST'], /^\/api\/library\/lookup$/, 'client'],
	[ALL, /^\/api\/library\//, 'admin'],
	[ALL, /^\/(delete|delete\/batch)$/, 'admin'],
	[ALL, /^\/(docs|redoc|openapi\.json)/, 'admin'],
	// /api/v1/ is client for the server, but this node only sends the read requests a paired
	// app makes: library trash, download policy and metadata edits stay out of reach.
	[READ, /^\/api\/v1\/(library\/trash|download-policy)(\/|$)/, 'admin'],
	[ALL, /^\/api\/v1\/(library\/trash|download-policy)(\/|$)/, 'admin'],
	[READ, /^\/api\/v1\//, 'client'],
	[READ, /^\/(tracks|list|playlists|lyrics|cover|playlist-cover)$/, 'client'],
	[READ, /^\/(downloads|media)\//, 'client'],
	[READ, /^\/api\/(songs|albums|artists)\/search$/, 'client'],
	[READ, /^\/api\/discover\/chart$/, 'client'],
	[READ, /^\/api\/finder\//, 'client'],
	[READ, /^\/api\/similar\//, 'client'],
	[READ, /^\/api\/artists\//, 'client'],
	[READ, /^\/api\/(song\/url|url|url\/resolve|preview|stream|buy)$/, 'client'],
	[READ, /^\/api\/stream\/file$/, 'client'],
	[['POST'], /^\/api\/download\/(url|batch|album)$/, 'client'],
	[READ, /^\/api\/queue(\/state)?$/, 'client'],
	[READ, /^\/api\/playlists\/(batches|incomplete)/, 'client'],
	[READ, /^\/api\/likes$/, 'client'],
	[['PUT'], /^\/api\/likes$/, 'client'],
	[['POST'], /^\/api\/stream\/prefetch$/, 'client'],
	[['POST'], /^\/api\/artists\/(art\/bulk|profile\/ensure)$/, 'client'],
	[['POST'], /^\/api\/discover(\/collections(\/deezer|\/spotify)?|\/listens)?$/, 'client'],
	[ALL, /^\/api\/discover\/blocked$/, 'client'],
	[READ, /^\/api\/podcasts\//, 'client'],
	[['POST'], /^\/api\/podcasts\/(resolve|episodes\/\d+\/download)$/, 'client'],
	[['PUT'], /^\/api\/podcasts\/episodes\/\d+\/playback$/, 'client'],
	[['POST'], /^\/api\/activity\/playback$/, 'client'],
	[READ, /^\/api\/monitor\/playlists$/, 'client'],
	[READ, /^\/api\/check_update$/, 'client'],
];

const PROTECTED_PREFIXES = [
	'/api/',
	'/downloads/',
	'/media/',
	'/tracks',
	'/list',
	'/playlists',
	'/lyrics',
	'/cover',
	'/playlist-cover',
	'/delete',
	'/docs',
	'/redoc',
	'/openapi.json',
];

/**
 * The scope this node allows for `method` on `path`: the Downtify route table, narrowed to
 * what a paired device does. Anything that is not "public" or "client" is refused before
 * the request is sent (Custom API Call), so the node never performs an admin or browser-only
 * operation, even on a server with accounts turned off.
 */
export function routeScope(method: string, path: string): Scope {
	if (!PROTECTED_PREFIXES.some((p) => path.startsWith(p))) return 'admin';
	const m = method.toUpperCase();
	for (const [methods, re, scope] of RULES) {
		if ((methods.includes('*') || methods.includes(m)) && re.test(path)) return scope;
	}
	return 'admin';
}

export function isDeviceRoute(method: string, path: string): boolean {
	const scope = routeScope(method, path);
	return scope === 'public' || scope === 'client';
}

// ---------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------

export const REDACTED = '[REDACTED]';

// Every pattern is bounded so that redaction stays linear on large untrusted text (no ReDoS).
const SECRET_PATTERNS: RegExp[] = [
	/dtfy_[a-z0-9]{6,32}_[A-Za-z0-9_-]{16,128}/g,
	/(Bearer\s{1,8})[^\s"',;]{1,1024}/gi,
	/("?(?:password|token|secret|ticket|sig)"?\s{0,8}[:=]\s{0,8})("[^"\n]{0,1024}"|[^\s,;&}"]{1,1024})/gi,
	/(Authorization\s{0,8}[:=]\s{0,8})[^\r\n,;"]{1,1024}/gi,
	/(Cookie\s{0,8}[:=]\s{0,8})[^\r\n"]{1,2048}/gi,
];

/**
 * Removes secrets from a string. Known secret values are replaced verbatim (also URL encoded),
 * well-known token formats are replaced by pattern.
 */
export function redactString(text: string, secrets: readonly string[] = []): string {
	let out = text;
	for (const secret of secrets) {
		if (!secret) continue;
		const variants = new Set([secret, encodeURIComponent(secret)]);
		for (const v of variants) out = out.split(v).join(REDACTED);
	}
	for (const re of SECRET_PATTERNS) {
		out = out.replace(re, (match, prefix?: string) =>
			typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED,
		);
	}
	return out;
}

const SECRET_KEYS = new Set(['password', 'token', 'secret', 'authorization', 'cookie', 'ticket', 'sig']);

function isSecretKey(key: string): boolean {
	const k = key.toLowerCase();
	return SECRET_KEYS.has(k) || k.includes('password') || k.includes('secret') || k.endsWith('_token');
}

/** Deep copy of a value with secret keys removed and secret values redacted. */
export function redactValue<T>(value: T, secrets: readonly string[] = [], depth = 0): T {
	if (depth > 32) return (value !== null && typeof value === 'object' ? '[TRUNCATED]' : redactValue(value, secrets, 0)) as T;
	if (typeof value === 'string') return redactString(value, secrets) as unknown as T;
	if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets, depth + 1)) as unknown as T;
	if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (k === '__proto__') continue;
			if (isSecretKey(k) && v !== null && v !== undefined && v !== '') out[k] = REDACTED;
			else out[k] = redactValue(v, secrets, depth + 1);
		}
		return out as T;
	}
	return value;
}
