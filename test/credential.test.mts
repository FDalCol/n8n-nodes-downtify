import type { IHttpRequestOptions } from 'n8n-workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeDowntify, TOKEN, Trap } from './helpers/fakeDowntify.mts';
import { credentialType, credentials, evalCredentialExpression, runCredentialTest } from './helpers/harness.mts';

let server: FakeDowntify;
let trap: Trap;

beforeAll(async () => {
	server = await new FakeDowntify().start();
	trap = await new Trap().start();
});
afterAll(async () => {
	await server.stop();
	await trap.stop();
});
beforeEach(() => server.reset());

const authenticate = credentialType.authenticate as (c: Record<string, unknown>, o: IHttpRequestOptions) => Promise<IHttpRequestOptions>;

describe('credential', () => {
	it('adds the device token as Authorization: Bearer', async () => {
		const out = await authenticate({ authentication: 'deviceToken', deviceToken: ` ${TOKEN} ` }, { url: '/x', headers: { Accept: 'application/json' } });
		expect(out.headers).toEqual({ Accept: 'application/json', Authorization: `Bearer ${TOKEN}` });
		const none = await authenticate({ authentication: 'deviceToken', deviceToken: '' }, { url: '/x' });
		expect(none.headers).toBeUndefined();
	});

	it('offers Username & Password (default) and Device Token, with secrets in password fields', () => {
		const byName = Object.fromEntries(credentialType.properties.map((p) => [p.name, p]));
		expect(Object.keys(byName)).toEqual(['authentication', 'baseUrl', 'username', 'password', 'deviceToken', 'sessionToken', 'sessionFingerprint']);
		expect(byName.authentication.default).toBe('password');
		expect(byName.authentication.options!.map((o) => (o as { value: string }).value)).toEqual(['deviceToken', 'password']);
		expect(byName.password.typeOptions).toEqual({ password: true });
		expect(byName.deviceToken.typeOptions).toEqual({ password: true });
		// Hidden and expirable: n8n runs preAuthentication when empty and after a 401;
		// password: n8n never sends the stored token to the browser
		expect(byName.sessionToken).toMatchObject({ type: 'hidden', default: '', typeOptions: { expirable: true, password: true } });
		expect(byName.sessionFingerprint.type).toBe('hidden');
		expect(typeof credentialType.preAuthentication).toBe('function');
	});

	it('the test request uses GET /api/me and only http(s) base URLs', () => {
		const req = credentialType.test.request;
		expect(req.url).toBe('/api/me');
		expect(req.method).toBe('GET');
		expect(req.disableFollowRedirect).toBe(true);
		expect(evalCredentialExpression(req.baseURL, { baseUrl: 'http://downtify.local:8000//' })).toBe('http://downtify.local:8000');
		expect(evalCredentialExpression(req.baseURL, { baseUrl: 'https://music.example/downtify' })).toBe('https://music.example/downtify');
		for (const bad of ['ftp://x', 'http://u:p@x', 'http://x/?a=1', 'http://x/#f', 'javascript:alert(1)', '']) {
			expect(String(evalCredentialExpression(req.baseURL, { baseUrl: bad })), bad).toMatch(/\.invalid$/);
		}
	});

	it('succeeds with a valid token and explains 401 and 403', async () => {
		expect(await runCredentialTest(credentials(server))).toEqual({ status: 'OK', message: 'Connection successful!' });
		expect(server.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(server.requestsTo('POST', '/api/auth/token')).toHaveLength(0);
		const wrong = await runCredentialTest(credentials(server, { deviceToken: 'dtfy_abcdefghjkmn_revokedrevokedrevokedrevokedrevoked' }));
		expect(wrong).toEqual({ status: 'Error', message: expect.stringMatching(/wrong or was revoked/) });
		const empty = await runCredentialTest(credentials(server, { deviceToken: '' }));
		expect(empty.message).toMatch(/^Authentication failed \(401\)/);
		server.on('GET', '/api/me', () => ({ status: 403, json: { detail: 'This needs a signed-in browser' } }));
		const forbidden = await runCredentialTest(credentials(server));
		expect(forbidden.message).toMatch(/Access denied \(403\)/);
	});

	it('works without a token on a server with accounts turned off', async () => {
		server.authDisabled = true;
		expect((await runCredentialTest(credentials(server, { deviceToken: '' }))).status).toBe('OK');
	});

	it('does not follow a redirect to another host', async () => {
		server.on('GET', '/api/me', () => ({ status: 302, headers: { Location: `${trap.url}/api/me` } }));
		expect(await runCredentialTest(credentials(server))).toEqual({ status: 'Error', message: 'Found' });
		expect(trap.hits).toHaveLength(0);
	});
});
