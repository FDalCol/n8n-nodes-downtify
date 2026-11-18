import { jsonParse, type IDataObject } from 'n8n-workflow';

import { data, list, type ResourceHandlers } from '../../shared/engine';
import { hasControlChars, isDeviceRoute, isSafeKey, routeScope, validateApiPath } from '../../shared/security';
import type { DowntifyMethod } from '../../shared/transport';

const PARAM_NAME = /^[A-Za-z0-9_.\-[\]]{1,128}$/;
const METHODS: DowntifyMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export const customApiCallHandlers: ResourceHandlers = {
	call: async (ctx) => {
		const method = ctx.str('method', 'GET').toUpperCase() as DowntifyMethod;
		if (!METHODS.includes(method)) throw ctx.client.error('Invalid method');
		const path = ctx.guard(() => validateApiPath(ctx.str('path')));
		if (!isDeviceRoute(method, path)) {
			const scope = routeScope(method, path);
			const reason =
				scope === 'signIn'
					? 'sign-in and pairing are never done by this node (each sign-in creates a new device)'
					: `it needs ${scope === 'user' ? 'a signed-in browser' : 'an admin'}, not a paired device`;
			throw ctx.client.error(
				`${method} ${path} is not allowed: ${reason}`,
				'This node only uses the endpoints Downtify allows to a device token.',
			);
		}

		const qs: IDataObject = {};
		const raw = ctx.param<{ parameter?: Array<{ name?: string; value?: unknown }> }>('queryParameters', {}) ?? {};
		for (const entry of raw.parameter ?? []) {
			const name = String(entry.name ?? '').trim();
			if (name === '') continue;
			if (!PARAM_NAME.test(name) || !isSafeKey(name)) throw ctx.client.error(`Invalid query parameter name "${name.slice(0, 64)}"`);
			// Signed URL parameters are never built by hand: a token must not end up in a URL
			if (['sig', 'kid', 'exp', 'token', 'ticket'].includes(name.toLowerCase())) {
				throw ctx.client.error(`Query parameter "${name}" is not allowed`);
			}
			const value = entry.value === undefined || entry.value === null ? '' : String(entry.value);
			if (hasControlChars(value)) throw ctx.client.error(`Query parameter "${name}" contains control characters`);
			qs[name] = value;
		}

		let body: unknown;
		if (method !== 'GET') {
			const rawBody = ctx.param<unknown>('body', '{}');
			if (typeof rawBody === 'string') {
				try {
					body = rawBody.trim() === '' ? undefined : jsonParse(rawBody);
				} catch {
					throw ctx.client.error('Body must be valid JSON');
				}
			} else {
				body = rawBody;
			}
		}

		const res = await ctx.client.request(method, path, { qs, body });
		return Array.isArray(res.data) ? list(res.data) : data(res.data);
	},
};
