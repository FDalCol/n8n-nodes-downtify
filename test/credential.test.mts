/**
 * Credential: Bearer header, test request (GET /api/me) and its 401/403 messages.
 */
import type { IHttpRequestOptions } from 'n8n-workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeDowntify, TOKEN, Trap } from './helpers/fakeDowntify.mts';
import { credentialType, credentials, evalCredentialExpression, httpRequest } from './helpers/harness.mts';

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

/** Runs the credential test request like n8n does: expressions, authenticate(), then the request. */
async function testCredential(creds: Record<string, unknown>): Promise<{ statusCode: number; message?: string }> {
	const req = credentialType.test.request;
	const options: IHttpRequestOptions = {
		baseURL: String(evalCredentialExpression(req.baseURL, creds)),
		url: String(req.url),
		method: req.method,
		headers: req.headers as Record<string, string>,
		disableFollowRedirect: req.disableFollowRedirect,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		timeout: 5000,
	};
	const res = (await httpRequest(await authenticate(creds, options))) as { statusCode: number };
	const rule = credentialType.test.rules?.find(
		(r) => r.type === 'responseCode' && (r.properties as { value: number }).value === res.statusCode,
	);
	return { statusCode: res.statusCode, message: rule ? (rule.properties as { message: string }).message : undefined };
}

describe('credential', () => {
	it('adds the device token as Authorization: Bearer', async () => {
		const out = await authenticate({ deviceToken: ` ${TOKEN} ` }, { url: '/x', headers: { Accept: 'application/json' } });
		expect(out.headers).toEqual({ Accept: 'application/json', Authorization: `Bearer ${TOKEN}` });
		const none = await authenticate({ deviceToken: '' }, { url: '/x' });
		expect(none.headers).toBeUndefined();
	});

	it('defines a password field for the token and never asks for a username or password', () => {
		const names = credentialType.properties.map((p) => p.name);
		expect(names).toEqual(['baseUrl', 'deviceToken', 'setupNotice']);
		expect(credentialType.properties[1].typeOptions).toEqual({ password: true });
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
		expect(await testCredential(credentials(server))).toEqual({ statusCode: 200, message: undefined });
		expect(server.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
		const wrong = await testCredential(credentials(server, { deviceToken: 'dtfy_abcdefghjkmn_revokedrevokedrevokedrevokedrevoked' }));
		expect(wrong.statusCode).toBe(401);
		expect(wrong.message).toMatch(/wrong or was revoked/);
		const empty = await testCredential(credentials(server, { deviceToken: '' }));
		expect(empty.statusCode).toBe(401);
		server.on('GET', '/api/me', () => ({ status: 403, json: { detail: 'This needs a signed-in browser' } }));
		const forbidden = await testCredential(credentials(server));
		expect(forbidden.statusCode).toBe(403);
		expect(forbidden.message).toMatch(/Access denied \(403\)/);
	});

	it('works without a token on a server with accounts turned off', async () => {
		server.authDisabled = true;
		expect((await testCredential(credentials(server, { deviceToken: '' }))).statusCode).toBe(200);
	});

	it('does not follow a redirect to another host', async () => {
		server.on('GET', '/api/me', () => ({ status: 302, headers: { Location: `${trap.url}/api/me` } }));
		expect((await testCredential(credentials(server))).statusCode).toBe(302);
		expect(trap.hits).toHaveLength(0);
	});
});
