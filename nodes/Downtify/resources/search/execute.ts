import type { IDataObject } from 'n8n-workflow';

import { data, list, type ResourceHandlers } from '../../shared/engine';
import {
	RESOLVE_TIMEOUT_MS,
	validateDeezerId,
	validateInteger,
	validateLink,
	validateText,
} from '../../shared/security';

const RELEASE_TYPES = ['Album', 'Compilation', 'EP', 'Single'];

export const searchHandlers: ResourceHandlers = {
	resolveUrl: async (ctx) => {
		const url = ctx.guard(() => validateLink(ctx.str('url')));
		return data(await ctx.client.get('/api/url/resolve', { url }, { timeoutMs: RESOLVE_TIMEOUT_MS }));
	},

	searchSongs: async (ctx) => {
		const query = ctx.guard(() => validateText(ctx.str('query'), 'Query'));
		return list(await ctx.client.get('/api/songs/search', { query }));
	},

	finderSearch: async (ctx) => {
		const query = ctx.guard(() => validateText(ctx.str('query'), 'Query'));
		const limit = ctx.guard(() => validateInteger(ctx.param('limit', 50), 'Limit', 1, 50));
		const type = ctx.str('resultType', 'all');
		const result = (await ctx.client.get<IDataObject>('/api/finder/search', { query, limit })) ?? {};
		if (type === 'all') return data(result);
		if (!['songs', 'albums', 'artists'].includes(type)) throw ctx.client.error(`Unknown result type "${type.slice(0, 32)}"`);
		return list(Array.isArray(result[type]) ? result[type] : []);
	},

	getArtistAlbums: async (ctx) => {
		const artistId = ctx.guard(() => validateDeezerId(ctx.str('artistId')));
		const raw = ctx.param<unknown>('releaseTypes', []);
		const types = (Array.isArray(raw) ? raw : String(raw ?? '').split(',')).map((t) => String(t).trim()).filter(Boolean);
		const unknown = types.find((t) => !RELEASE_TYPES.includes(t));
		if (unknown) throw ctx.client.error(`Unknown release type "${unknown.slice(0, 32)}" (use ${RELEASE_TYPES.join(', ')})`);
		const rows = await ctx.client.get<unknown>('/api/finder/artist/albums', { artist_id: artistId });
		const albums = (Array.isArray(rows) ? rows : []).filter(
			(r): r is IDataObject => !!r && typeof r === 'object' && (!types.length || types.includes(String((r as IDataObject).release_type))),
		);
		return list(albums);
	},
};
