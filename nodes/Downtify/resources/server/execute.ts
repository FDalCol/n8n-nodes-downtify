import type { IDataObject } from 'n8n-workflow';

import { data, type ResourceHandlers } from '../../shared/engine';

export const serverHandlers: ResourceHandlers = {
	health: async (ctx) => {
		// Downtify 3.9+ answers 503 {"status": "database_unavailable"} when PostgreSQL is down
		const res = await ctx.client.request<IDataObject>('GET', '/api/health', { acceptStatus: [503] });
		const body = res.data && typeof res.data === 'object' ? res.data : {};
		if (res.statusCode === 503) {
			if (body.status === 'database_unavailable') {
				throw ctx.client.error(
					'Downtify is running but its database is unavailable (HTTP 503 database_unavailable)',
					'Check the PostgreSQL server configured for Downtify.',
				);
			}
			throw ctx.client.error('Downtify is not available (HTTP 503)');
		}
		return data({ ...body, healthy: body.status === 'ok' });
	},

	version: async (ctx) => {
		const version = await ctx.client.get<unknown>('/api/version');
		return data({ version: typeof version === 'string' ? version : version ?? null });
	},

	getMe: async (ctx) => data(await ctx.client.get('/api/me')),
};
