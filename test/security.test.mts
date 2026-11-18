import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isDeviceRoute, redactString, redactValue, routeScope, validateApiPath } from '../nodes/Downtify/shared/security';
import { FakeDowntify, TOKEN, Trap } from './helpers/fakeDowntify.mts';
import { credentials, runNode, runNodeError, runNodeJson, sentRequests, type Params } from './helpers/harness.mts';

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
beforeEach(() => {
	server.reset();
	sentRequests.length = 0;
});

const state = { resource: 'queue', operation: 'getState' };
const custom = (method: string, path: string, extra: Params = {}): Params => ({ resource: 'customApiCall', operation: 'call', method, path, ...extra });

describe('credential values', () => {
	it('rejects unsafe base URLs before any request', async () => {
		for (const baseUrl of [
			'ftp://downtify.local',
			'http://user:pass@downtify.local',
			'http://downtify.local/?x=1',
			'http://downtify.local/#frag',
			'http://downtify.local/a/../b',
			'http://downtify.local/%2e%2e',
			'http://downtify.local/api',
			'not a url',
			'',
		]) {
			const err = await runNodeError({ credentials: credentials(server, { baseUrl }), params: state });
			expect(err.message, baseUrl).toMatch(/Base URL/);
		}
		expect(server.requests).toHaveLength(0);
	});

	it('keeps a reverse proxy path prefix and strips trailing slashes', async () => {
		const prefixed = await new FakeDowntify().start();
		try {
			await runNode({ credentials: credentials(prefixed, { baseUrl: `${prefixed.url}/downtify///` }), params: state }).catch(() => undefined);
			expect(prefixed.requests[0].path).toBe('/downtify/api/queue/state');
		} finally {
			await prefixed.stop();
		}
	});

	it('sends the token only as Authorization: Bearer, never in the URL', async () => {
		await runNodeJson({ credentials: credentials(server), params: { resource: 'search', operation: 'searchSongs', query: 'x' } });
		expect(server.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
		for (const r of server.requests) expect(r.path + r.query.toString()).not.toContain(TOKEN);
		for (const o of sentRequests) expect(String(o.url) + JSON.stringify(o.qs ?? {})).not.toContain(TOKEN);
		expect(sentRequests[0].disableFollowRedirect).toBe(true);
		expect(sentRequests[0].maxResponseBodyBytes).toBeGreaterThan(0);
		expect(sentRequests[0].timeout).toBeGreaterThan(0);
	});

	it('works without a token when the server has accounts turned off', async () => {
		server.authDisabled = true;
		const [out] = await runNodeJson({ credentials: credentials(server, { deviceToken: '' }), params: state });
		expect(out).toMatchObject({ paused: false });
		expect(server.requests[0].headers.authorization).toBeUndefined();
	});

	it('rejects a token with spaces or control characters', async () => {
		const err = await runNodeError({ credentials: credentials(server, { deviceToken: 'dtfy_a b' }), params: state });
		expect(err.message).toBe('Device Token contains invalid characters');
	});
});

describe('401 and 403', () => {
	it('explains a wrong or revoked token', async () => {
		const err = await runNodeError({ credentials: credentials(server, { deviceToken: 'dtfy_abcdefghjkmn_wrongwrongwrongwrongwrongwrongwrong' }), params: state });
		expect(err.message).toBe('Downtify API error 401: Invalid or revoked token');
		expect(err.description).toMatch(/wrong or was revoked/);
	});

	it('explains a missing token', async () => {
		const err = await runNodeError({ credentials: credentials(server, { deviceToken: '' }), params: state });
		expect(err.message).toBe('Downtify API error 401: Sign in required');
		expect(err.description).toMatch(/requires a device token/);
	});

	it('explains a 403 for a device token', async () => {
		server.on('GET', '/api/queue/state', () => ({ status: 403, json: { detail: 'This needs a signed-in browser' } }));
		const err = await runNodeError({ credentials: credentials(server), params: state });
		expect(err.message).toBe('Downtify API error 403: This needs a signed-in browser');
		expect(err.description).toMatch(/cannot use this endpoint/);
	});
});

describe('continueOnFail and pairedItem', () => {
	it('returns { error } for the failing item and keeps going', async () => {
		const out = await runNode({
			credentials: credentials(server),
			params: [state, { resource: 'library', operation: 'getTrack', trackId: 'nope' }, { resource: 'server', operation: 'version' }],
			continueOnFail: true,
		});
		expect(out.map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
		expect(out[1].json).toEqual({ error: 'Downtify API error 404: Track not found' });
		expect(out[2].json).toEqual({ version: '3.8.1' });
	});
});

describe('redirects are never followed', () => {
	it('fails on a redirect to another host without contacting it', async () => {
		server.on('GET', '/api/queue/state', () => ({ status: 302, headers: { Location: `${trap.url}/api/queue/state` } }));
		const err = await runNodeError({ credentials: credentials(server), params: state });
		expect(err.message).toMatch(/redirect \(HTTP 302\)/);
		expect(trap.hits).toHaveLength(0);
	});
});

describe('token redaction', () => {
	it('removes the token from error messages and outputs', async () => {
		server.on('GET', '/api/queue/state', (req) => ({ status: 500, json: { detail: `crash with ${String(req.headers.authorization)}` } }));
		const err = await runNodeError({ credentials: credentials(server), params: state });
		expect(err.message).not.toContain(TOKEN);
		expect(err.message).toContain('[REDACTED]');
		server.on('GET', '/api/v1/playlists', () => ({ json: [{ name: `echo ${TOKEN}`, token: 'abc', device_token: 'x' }] }));
		const [out] = await runNodeJson({ credentials: credentials(server), params: { resource: 'library', operation: 'getPlaylists', returnAll: true } });
		expect(JSON.stringify(out)).not.toContain(TOKEN);
		expect(out).toEqual({ name: 'echo [REDACTED]', token: '[REDACTED]', device_token: '[REDACTED]' });
	});

	it('redacts dtfy tokens and Bearer headers by pattern', () => {
		expect(redactString('Authorization: Bearer abc.def')).toBe('Authorization: [REDACTED]');
		expect(redactString('got dtfy_abcdefghjkmn_0123456789abcdefghij0123456789AB here')).toBe('got [REDACTED] here');
		expect(redactValue({ a: { password: 'p', list: ['Bearer xyz'] } })).toEqual({ a: { password: '[REDACTED]', list: ['Bearer [REDACTED]'] } });
	});

	it('the source never logs to the console', () => {
		const files = (dir: string): string[] =>
			readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
		for (const file of [...files('nodes'), ...files('credentials')].filter((f) => f.endsWith('.ts'))) {
			expect(readFileSync(file, 'utf8'), file).not.toMatch(/console\.(log|info|warn|error|debug)/);
		}
	});
});

describe('Custom API Call', () => {
	it('calls a device endpoint with query and body', async () => {
		const [out] = await runNodeJson({ credentials: credentials(server), params: custom('GET', 'api/queue/state', { queryParameters: { parameter: [{ name: 'x', value: '1' }] } }) });
		expect(out).toMatchObject({ paused: false });
		expect(server.requests[0].query.get('x')).toBe('1');
		await runNodeJson({ credentials: credentials(server), params: custom('POST', '/api/podcasts/resolve', { body: '{"url":"https://feeds.example/a.xml"}' }) });
		expect(server.requestsTo('POST', '/api/podcasts/resolve')[0].json).toEqual({ url: 'https://feeds.example/a.xml' });
		const list = await runNodeJson({ credentials: credentials(server), params: custom('GET', '/api/monitor/playlists') });
		expect(list).toHaveLength(1);
	});

	it('rejects absolute URLs, traversal and malformed paths before sending', async () => {
		for (const path of [
			'http://evil.example/api/queue',
			'//evil.example/api/queue',
			'../api/queue',
			'/api/../api/settings',
			'/api/%2e%2e/settings',
			'/api/%2fsettings',
			'/api/queue%252f',
			'/api\\queue',
			'/api/queue?x=1',
			'/api/queue#x',
			'/api//queue',
			'/api/queue;x',
			'/api/qu eue',
			'',
		]) {
			const err = await runNodeError({ credentials: credentials(server), params: custom('GET', path) });
			expect(err.message, path).toMatch(/Path|URL|not allowed|forbidden|traversal|required/i);
		}
		expect(server.requests).toHaveLength(0);
	});

	it('refuses admin and browser-only endpoints', async () => {
		for (const [method, path] of [
			['GET', '/api/settings'],
			['POST', '/api/settings/update'],
			['POST', '/api/queue/pause'],
			['POST', '/api/queue/resume'],
			['DELETE', '/api/queue'],
			['DELETE', '/api/queue/item'],
			['GET', '/api/monitor/stats'],
			['GET', '/api/monitor/playlists/1/tracks'],
			['POST', '/api/monitor/playlists'],
			['GET', '/api/users'],
			['POST', '/api/auth/token'],
			['GET', '/api/auth/devices'],
			['DELETE', '/delete'],
			['POST', '/api/podcasts/subscribe'],
			['POST', '/api/v1/library/trash/confirm'],
			['PATCH', '/api/v1/tracks/1/metadata'],
			['GET', '/'],
			['GET', '/index.html'],
		]) {
			const err = await runNodeError({ credentials: credentials(server), params: custom(method, path) });
			expect(err.message, `${method} ${path}`).toMatch(/is not allowed/);
		}
		expect(server.requests).toHaveLength(0);
	});

	it('rejects unsafe query parameter names and invalid JSON', async () => {
		for (const name of ['__proto__', 'sig', 'token', 'a b']) {
			const err = await runNodeError({ credentials: credentials(server), params: custom('GET', '/api/queue', { queryParameters: { parameter: [{ name, value: 'x' }] } }) });
			expect(err.message, name).toMatch(/query parameter/i);
		}
		const err = await runNodeError({ credentials: credentials(server), params: custom('POST', '/api/podcasts/resolve', { body: '{oops' }) });
		expect(err.message).toBe('Body must be valid JSON');
	});

	it('route policy follows the Downtify rules for device tokens', () => {
		expect(routeScope('GET', '/api/health')).toBe('public');
		expect(routeScope('GET', '/api/me')).toBe('client');
		expect(routeScope('PATCH', '/api/me')).toBe('user');
		expect(routeScope('GET', '/api/queue')).toBe('client');
		expect(routeScope('DELETE', '/api/queue/completed')).toBe('user');
		expect(routeScope('POST', '/api/queue/pause')).toBe('admin');
		expect(routeScope('POST', '/api/download/batch')).toBe('client');
		expect(routeScope('POST', '/api/download/csv')).toBe('user');
		expect(routeScope('GET', '/api/library/albums')).toBe('client');
		expect(routeScope('GET', '/api/library/usage')).toBe('admin');
		expect(routeScope('GET', '/api/library/playlists/details')).toBe('user');
		expect(routeScope('GET', '/api/v1/tracks/x')).toBe('client');
		expect(isDeviceRoute('POST', '/api/podcasts/episodes/12/download')).toBe(true);
		expect(isDeviceRoute('PUT', '/api/podcasts/episodes/12/playback')).toBe(true);
		expect(isDeviceRoute('POST', '/api/activity/playback')).toBe(true);
		expect(isDeviceRoute('GET', '/api/activity')).toBe(false);
		expect(validateApiPath('api/queue/')).toBe('/api/queue');
	});
});

describe('responses', () => {
	it('reports a non-JSON answer clearly', async () => {
		server.on('GET', '/api/queue/state', () => ({ raw: '<html>login page</html>' }));
		const err = await runNodeError({ credentials: credentials(server), params: state });
		expect(err.message).toMatch(/not a Downtify JSON response/);
	});

	it('reports a refused connection clearly', async () => {
		const gone = await new FakeDowntify().start();
		const url = gone.url;
		await gone.stop();
		const err = await runNodeError({ credentials: credentials({ url }), params: state });
		expect(err.message).toMatch(/Connection refused|Request to Downtify failed/);
	});
});
