import type { ICredentialDataDecryptedObject, IDataObject } from 'n8n-workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeDowntify, PASSWORD, Trap, USERNAME } from './helpers/fakeDowntify.mts';
import {
	credentialSaves,
	passwordCredentials,
	poll,
	readCredentials,
	runCredentialTest,
	runNode,
	runNodeError,
	runNodeJson,
	sentRequests,
} from './helpers/harness.mts';

let server: FakeDowntify;
let other: FakeDowntify;
let trap: Trap;

beforeAll(async () => {
	server = await new FakeDowntify().start();
	other = await new FakeDowntify().start();
	trap = await new Trap().start();
});
afterAll(async () => {
	await server.stop();
	await other.stop();
	await trap.stop();
});
beforeEach(() => {
	server.reset();
	other.reset();
	sentRequests.length = 0;
	credentialSaves.count = 0;
});

const getMe = { resource: 'server', operation: 'getMe' };
const signIns = (s: FakeDowntify = server) => s.requestsTo('POST', '/api/auth/token');
const bearer = (s: FakeDowntify, path: string) => s.requestsTo('GET', path).map((r) => r.headers.authorization);

/** Everything n8n sent, received or showed must be free of the password. */
function expectNoPasswordLeak(...outputs: unknown[]): void {
	for (const req of sentRequests) {
		expect(String(req.url)).not.toContain(PASSWORD);
		expect(JSON.stringify(req.qs ?? {})).not.toContain(PASSWORD);
		expect(JSON.stringify(req.headers ?? {})).not.toContain(PASSWORD);
	}
	for (const out of outputs) expect(JSON.stringify(out, Object.getOwnPropertyNames(out ?? {}))).not.toContain(PASSWORD);
}

describe('Username & Password', () => {
	it('first run: signs in once, stores the device token and uses it as Bearer', async () => {
		const stored = passwordCredentials(server);
		const [me] = await runNodeJson({ credentials: stored, params: getMe });
		expect(me).toMatchObject({ user: { username: 'n8n' } });

		expect(signIns()).toHaveLength(1);
		expect(signIns()[0].json).toEqual({ username: USERNAME, password: PASSWORD, device_name: 'n8n', platform: 'n8n' });
		expect(signIns()[0].headers.authorization).toBeUndefined();
		const token = server.issuedTokens[0];
		expect(stored.sessionToken).toBe(token);
		expect(String(stored.sessionTokenFingerprint)).toMatch(/^v2\./);
		expect(String(stored.sessionTokenFingerprint)).not.toContain(PASSWORD);
		expect(credentialSaves.count).toBe(1);
		expect(bearer(server, '/api/me')).toEqual([`Bearer ${token}`]);
		// The password travels only in the JSON body of the sign-in request
		const login = sentRequests.find((r) => String(r.url).endsWith('/api/auth/token'))!;
		expect(login).toMatchObject({ method: 'POST', disableFollowRedirect: true, ignoreHttpStatusErrors: true });
		expect(String(login.body)).toContain(PASSWORD);
		expectNoPasswordLeak(me);
	});

	it('later runs reuse the stored token without signing in again', async () => {
		const stored = passwordCredentials(server);
		await runNode({ credentials: stored, params: getMe });
		await runNode({ credentials: stored, params: getMe });
		await runNode({ credentials: stored, params: [getMe, { resource: 'queue', operation: 'getState' }] });
		await poll({ credentials: stored, params: { event: 'downloadFinished' }, staticData: {} });
		expect(signIns()).toHaveLength(1);
		expect(credentialSaves.count).toBe(1);
		const token = server.issuedTokens[0];
		expect(new Set(server.requests.filter((r) => r.path !== '/api/auth/token').map((r) => r.headers.authorization))).toEqual(
			new Set([`Bearer ${token}`]),
		);
	});

	it('after a 401 (token revoked) signs in once more, stores the new token and repeats the request', async () => {
		const stored = passwordCredentials(server);
		await runNode({ credentials: stored, params: getMe });
		const first = server.issuedTokens[0];
		server.revoke(first);
		server.requests.length = 0;

		const out = await runNodeJson({
			credentials: stored,
			params: [{ resource: 'podcast', operation: 'resolve', url: 'https://feeds.example/p.xml' }, getMe],
		});
		expect(out[0]).toMatchObject({ name: 'Preview' });
		expect(out[1]).toMatchObject({ user: { username: 'n8n' } });
		expect(signIns()).toHaveLength(1);
		const second = server.issuedTokens[1];
		expect(second).not.toBe(first);
		expect(stored.sessionToken).toBe(second);
		// The POST was answered 401 first (not processed), then repeated once with the new token
		expect(server.requestsTo('POST', '/api/podcasts/resolve').map((r) => r.headers.authorization)).toEqual([
			`Bearer ${first}`,
			`Bearer ${second}`,
		]);
		expectNoPasswordLeak(out);
	});

	it('signs in again only once per execution even if Downtify keeps answering 401', async () => {
		const stored = passwordCredentials(server);
		await runNode({ credentials: stored, params: getMe });
		server.on('GET', '/api/queue/state', () => ({ status: 401, json: { detail: 'Invalid or revoked token' } }));
		const err = await runNodeError({ credentials: stored, params: { resource: 'queue', operation: 'getState' } });
		expect(err.message).toMatch(/^Downtify API error 401/);
		expect(signIns()).toHaveLength(1);
		expect(server.requestsTo('GET', '/api/queue/state')).toHaveLength(2);
	});

	it('wrong username or password: one attempt, a clear error, no password in errors or output', async () => {
		const stored = passwordCredentials(server, { password: 'wrong-password-123' });
		const err = await runNodeError({ credentials: stored, params: getMe });
		expect(err.message).toBe('Downtify rejected the username or password (401): Wrong username or password');
		expect(err.description).toMatch(/Check Username and Password/);
		expect(signIns()).toHaveLength(1);
		expect(stored.sessionToken).toBeUndefined();
		expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('wrong-password-123');

		const [item] = await runNode({ credentials: stored, params: getMe, continueOnFail: true });
		expect(item.json.error).toMatch(/rejected the username or password/);
		expect(JSON.stringify(item)).not.toContain('wrong-password-123');
	});

	it('wrong password after a revoked token: reports the sign-in error', async () => {
		const stored = passwordCredentials(server);
		await runNode({ credentials: stored, params: getMe });
		server.revoke(server.issuedTokens[0]);
		stored.password = 'changed-in-downtify';
		// Same fingerprint check: the token was issued for the old password, so it is not sent
		const err = await runNodeError({ credentials: stored, params: getMe });
		expect(err.message).toMatch(/^Downtify rejected the username or password \(401\)/);
		expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('changed-in-downtify');
	});

	it('never sends the stored token to another server or for another user', async () => {
		const stored = passwordCredentials(server);
		await runNode({ credentials: stored, params: getMe });
		const token = server.issuedTokens[0];

		stored.baseUrl = other.url;
		await runNode({ credentials: stored, params: getMe });
		expect(other.requests.map((r) => r.headers.authorization)).not.toContain(`Bearer ${token}`);
		expect(signIns(other)).toHaveLength(1);
		expect(stored.sessionToken).toBe(other.issuedTokens[0]);

		// Another user on the first server: no reuse of the other user's token
		const forUser = passwordCredentials(server, { sessionToken: token, sessionTokenFingerprint: stored.sessionTokenFingerprint, username: 'someone' });
		const err = await runNodeError({ credentials: forUser, params: getMe });
		expect(err.message).toMatch(/rejected the username or password/);
		expect(server.requests.filter((r) => r.path === '/api/me').map((r) => r.headers.authorization)).toEqual([`Bearer ${token}`, undefined, undefined]);
	});

	it('explains 409 (password sign-in turned off) and 429 (rate limit)', async () => {
		server.signInDisabled = true;
		const off = await runNodeError({ credentials: passwordCredentials(server), params: getMe });
		expect(off.message).toMatch(/^Downtify refused the sign-in \(409\)/);
		expect(off.description).toMatch(/use Device Token authentication/);

		server.on('POST', '/api/auth/token', () => ({ status: 429, json: { detail: 'Too many attempts' }, headers: { 'Retry-After': '42' } }));
		const limited = await runNodeError({ credentials: passwordCredentials(server), params: getMe });
		expect(limited.message).toBe('Too many sign-in attempts (429): Too many attempts');
		expect(limited.description).toMatch(/wait 42 s/);
	});

	it('redacts the password and the received token from error messages', async () => {
		const stored = passwordCredentials(server);
		server.on('GET', '/api/queue/state', (req) => ({
			status: 500,
			json: { detail: `boom ${PASSWORD} ${String(req.headers.authorization).slice(7)}` },
		}));
		const err = await runNodeError({ credentials: stored, params: { resource: 'queue', operation: 'getState' } });
		expect(err.message).toBe('Downtify API error 500: boom [REDACTED] [REDACTED]');
		server.on('POST', '/api/auth/token', (req) => ({ status: 500, json: { detail: `echo ${String((req.json as IDataObject).password)}` } }));
		const err2 = await runNodeError({ credentials: passwordCredentials(server), params: getMe });
		expect(err2.message).toBe('Sign-in to Downtify failed (HTTP 500): echo [REDACTED]');
	});

	it('does not follow a redirect of the sign-in request', async () => {
		server.on('POST', '/api/auth/token', () => ({ status: 307, headers: { Location: `${trap.url}/api/auth/token` } }));
		const err = await runNodeError({ credentials: passwordCredentials(server), params: getMe });
		expect(err.message).toMatch(/redirect \(HTTP 307\)/);
		expect(trap.hits).toHaveLength(0);
	});

	it('works for the trigger too', async () => {
		const stored = passwordCredentials(server);
		expect(await poll({ credentials: stored, params: { event: 'downloadFinished' }, staticData: {} })).toBeNull();
		expect(signIns()).toHaveLength(1);
		expect(stored.sessionToken).toBe(server.issuedTokens[0]);
	});
});

describe('Username & Password: hardening', () => {
	it('the stored fingerprint depends on the token, so it cannot be used to guess the password', async () => {
		const a = passwordCredentials(server);
		const b = passwordCredentials(server);
		await runNode({ credentials: a, params: getMe });
		await runNode({ credentials: b, params: getMe });
		expect(a.sessionToken).not.toBe(b.sessionToken);
		expect(a.sessionTokenFingerprint).not.toBe(b.sessionTokenFingerprint);
		// A fingerprint copied next to another token is not accepted
		const mixed = passwordCredentials(server, { sessionToken: a.sessionToken, sessionTokenFingerprint: b.sessionTokenFingerprint });
		server.requests.length = 0;
		await runNode({ credentials: mixed, params: getMe });
		expect(bearer(server, '/api/me')[0]).toBeUndefined();
	});

	it('redacts a password of 8+ characters also from outputs', async () => {
		server.on('GET', '/api/me', () => ({ json: { user: { username: 'n8n' }, note: `echo ${PASSWORD}` } }));
		const [me] = await runNodeJson({ credentials: passwordCredentials(server), params: getMe });
		expect(me.note).toBe('echo [REDACTED]');
	});

	it('a server that always answers 401: at most one renewal per execution, no loop', async () => {
		// Sign-in succeeds, but Downtify never accepts the token it returned
		server.on('POST', '/api/auth/token', () => ({ json: { token: `dtfy_aaaaaaaaaaaa_${'x'.repeat(40)}` } }));
		const stored = passwordCredentials(server);
		const items = await runNode({ credentials: stored, params: [getMe, getMe, getMe], continueOnFail: true });
		expect(items.map((i) => String(i.json.error))).toEqual([
			expect.stringMatching(/still refuses the device token after signing in again/),
			expect.stringMatching(/^Downtify API error 401/),
			expect.stringMatching(/^Downtify API error 401/),
		]);
		// First run: sign-in with an empty token, then one renewal
		expect(signIns()).toHaveLength(2);
		expect(server.requestsTo('GET', '/api/me').length).toBeLessThanOrEqual(6);

		server.requests.length = 0;
		await runNodeError({ credentials: stored, params: getMe });
		expect(signIns()).toHaveLength(1);
		expect(server.requestsTo('GET', '/api/me').length).toBeLessThanOrEqual(4);
	});

	it('never puts secrets in the messages of n8n errors', async () => {
		const stored = passwordCredentials(server, { password: 'wrong-password-123' });
		const err = (await runNodeError({ credentials: stored, params: getMe })) as Error & { messages?: string[]; description?: string };
		const all = JSON.stringify({ message: err.message, description: err.description, messages: err.messages, stack: err.stack });
		expect(all).not.toContain('wrong-password-123');
	});
});

describe('credential test (Test button)', () => {
	it('signs in when the form has no token, then reuses the stored token while it is valid', async () => {
		const stored = passwordCredentials(server);
		// New credential: the form holds the default empty session token
		expect(await runCredentialTest(stored, readCredentials(stored))).toEqual({ status: 'OK', message: 'Connection successful!' });
		expect(signIns()).toHaveLength(1);
		expect(stored.sessionToken).toBe(server.issuedTokens[0]);

		// Credential opened again: n8n restores the stored (redacted) token into the form
		expect((await runCredentialTest(stored)).status).toBe('OK');
		expect(signIns()).toHaveLength(1);

		// Saved again in a dialog still open since creation: the form still has no token
		const staleForm: ICredentialDataDecryptedObject = { ...readCredentials(stored), sessionToken: '', sessionTokenFingerprint: '' };
		expect((await runCredentialTest(stored, staleForm)).status).toBe('OK');
		expect(signIns()).toHaveLength(2);

		// A revoked token is replaced
		server.revoke(String(stored.sessionToken));
		expect((await runCredentialTest(stored)).status).toBe('OK');
		expect(signIns()).toHaveLength(3);
	});

	it('reports wrong credentials with the sign-in message', async () => {
		const stored = passwordCredentials(server, { password: 'nope-nope' });
		expect(await runCredentialTest(stored)).toEqual({
			status: 'Error',
			message: 'Downtify rejected the username or password (401): Wrong username or password',
		});
		expect(signIns()).toHaveLength(1);
		expectNoPasswordLeak();
	});
});

describe('Username & Password: failed sign-in', () => {
	it('a failed sign-in is tried once per execution, not once per item', async () => {
		const stored = passwordCredentials(server, { password: 'wrong-password-123' });
		const items = await runNode({ credentials: stored, params: [getMe, getMe, getMe], continueOnFail: true });
		expect(items.map((i) => String(i.json.error))).toEqual(Array(3).fill('Downtify rejected the username or password (401): Wrong username or password'));
		expect(signIns()).toHaveLength(1);
	});
});
