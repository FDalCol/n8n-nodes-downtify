import type { IDataObject } from 'n8n-workflow';

import { applyLimit, data, list, type OperationContext, type ResourceHandlers } from '../../shared/engine';
import { findAlbum, getLibraryAlbums } from '../../shared/library';
import { encodeSegment, validateText } from '../../shared/security';

/** Downtify's TRACK_QUERY_LIMIT_MAX for GET /tracks?limit=. */
const SERVER_TRACK_LIMIT = 200;

async function getList(ctx: OperationContext, path: string, qs?: IDataObject): Promise<unknown[]> {
	const limit = ctx.limit();
	const rows = await ctx.client.get<unknown>(path, qs);
	if (!Array.isArray(rows)) throw ctx.client.error(`Unexpected answer from GET ${path} (not a list)`);
	return applyLimit(rows, limit);
}

export const libraryHandlers: ResourceHandlers = {
	getSummary: async (ctx) => data(await ctx.client.get('/api/library/summary')),

	getAlbums: async (ctx) => {
		const limit = ctx.limit();
		return list(applyLimit(await getLibraryAlbums(ctx.client), limit));
	},

	getArtists: async (ctx) => list(await getList(ctx, '/api/library/artists')),

	getTracks: async (ctx) => {
		const filters = ctx.collection('trackFilters');
		const qs: IDataObject = {};
		for (const key of ['artist', 'album', 'playlist', 'q']) {
			if (filters[key] !== undefined) qs[key] = ctx.guard(() => validateText(filters[key], key, 500, false));
		}
		// A small limit is also sent to the server (it caps ?limit= at 200), so a large library is
		// not transferred for nothing; larger limits are applied here
		const limit = ctx.limit();
		if (limit !== undefined && limit <= SERVER_TRACK_LIMIT) qs.limit = limit;
		return list(await getList(ctx, '/tracks', qs));
	},

	getTrack: async (ctx) => {
		const id = ctx.guard(() => encodeSegment(ctx.str('trackId'), 'Track ID'));
		return data(await ctx.client.get(`/api/v1/tracks/${id}`));
	},

	getPlaylists: async (ctx) => list(await getList(ctx, '/api/v1/playlists')),

	findAlbum: async (ctx) => {
		const artist = ctx.guard(() => validateText(ctx.str('artist'), 'Artist', 500, false));
		const title = ctx.guard(() => validateText(ctx.str('title'), 'Album Title'));
		const result = await findAlbum(ctx.client, artist, title, { ignoreEdition: ctx.param('ignoreEdition', true) !== false });
		return data({ artist, title, ...result, matchCount: result.matches.length });
	},
};
