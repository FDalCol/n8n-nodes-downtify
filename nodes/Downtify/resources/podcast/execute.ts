import type { IDataObject } from 'n8n-workflow';

import { applyLimit, data, list, type ResourceHandlers } from '../../shared/engine';
import { assertQueueRunning } from '../../shared/queue';
import {
	MAX_WAIT_SECONDS,
	RESOLVE_TIMEOUT_MS,
	validateInteger,
	validateIntegerId,
	validateLink,
	validateText,
} from '../../shared/security';

function rowsOf(value: unknown): IDataObject[] {
	return (Array.isArray(value) ? value : []).filter((r): r is IDataObject => !!r && typeof r === 'object' && !Array.isArray(r));
}

export const podcastHandlers: ResourceHandlers = {
	getShows: async (ctx) => {
		const limit = ctx.limit();
		return list(applyLimit(rowsOf(await ctx.client.get('/api/podcasts/shows')), limit));
	},

	getShow: async (ctx) => {
		const id = ctx.guard(() => validateIntegerId(ctx.str('showId'), 'Show ID'));
		return data(await ctx.client.get(`/api/podcasts/shows/${id}`));
	},

	getEpisodes: async (ctx) => {
		const id = ctx.guard(() => validateIntegerId(ctx.str('showId'), 'Show ID'));
		const filters = ctx.collection('episodeFilters');
		const limit = ctx.limit();
		const answer =
			(await ctx.client.get<IDataObject>(`/api/podcasts/shows/${id}/episodes`, {
				include_dismissed: filters.includeDismissed === true,
			})) ?? {};
		const state = String(filters.downloadState ?? 'any');
		const episodes = rowsOf(answer.episodes).filter((e) => {
			if (state === 'downloaded') return !!e.filename;
			if (state === 'notDownloaded') return !e.filename;
			return true;
		});
		return list(applyLimit(episodes, limit));
	},

	search: async (ctx) => {
		const q = ctx.guard(() => validateText(ctx.str('query'), 'Query'));
		const limit = ctx.limit();
		const answer = (await ctx.client.get<IDataObject>('/api/podcasts/search', { q })) ?? {};
		return list(applyLimit(rowsOf(answer.results), limit));
	},

	resolve: async (ctx) => {
		const url = ctx.guard(() => validateLink(ctx.str('url')));
		return data(await ctx.client.post('/api/podcasts/resolve', { url }, { timeoutMs: RESOLVE_TIMEOUT_MS }));
	},

	downloadEpisode: async (ctx) => {
		const id = ctx.guard(() => validateIntegerId(ctx.str('episodeId'), 'Episode ID'));
		const timeout = ctx.guard(() => validateInteger(ctx.param('timeout', 3600), 'Timeout', 1, MAX_WAIT_SECONDS));
		// With the queue paused, Downtify holds the request until an admin resumes the queue
		await assertQueueRunning(ctx.client);
		const episode = await ctx.client.post<IDataObject>(`/api/podcasts/episodes/${id}/download`, undefined, {
			timeoutMs: timeout * 1000,
		});
		return data({ ...(episode ?? {}), downloaded: !!episode?.filename });
	},
};
