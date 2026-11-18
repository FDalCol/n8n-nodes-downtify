import { applyLimit, list, type ResourceHandlers } from '../../shared/engine';

export const monitorHandlers: ResourceHandlers = {
	getMany: async (ctx) => {
		const limit = ctx.limit();
		const rows = await ctx.client.get<unknown>('/api/monitor/playlists');
		if (!Array.isArray(rows)) throw ctx.client.error('Unexpected answer from GET /api/monitor/playlists (not a list)');
		return list(applyLimit(rows, limit));
	},
};
