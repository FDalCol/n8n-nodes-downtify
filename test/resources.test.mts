import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeDowntify, song } from './helpers/fakeDowntify.mts';
import { credentials, runNodeError, runNodeJson } from './helpers/harness.mts';

let server: FakeDowntify;

beforeAll(async () => {
	server = await new FakeDowntify().start();
});
afterAll(async () => {
	await server.stop();
});
beforeEach(() => server.reset());

const run = (params: Record<string, unknown>) => runNodeJson({ credentials: credentials(server), params });

describe('Queue', () => {
	it('Get Many adds the job ID and filters by status', async () => {
		server.advance = false;
		server.addJob(song('j1', 'One'), 'done');
		server.addJob(song('j2', 'Two'), 'error', { message: 'Error: boom' });
		server.addJob(song('j3', 'Three'), 'done', { message: 'Already on disk' });
		server.addJob({ name: 'No id', url: 'https://youtube.com/watch?v=x', artist: 'X' }, 'queued');
		const all = await run({ resource: 'queue', operation: 'getMany', returnAll: true });
		expect(all.map((r) => r.jobId)).toEqual(['j1', 'j2', 'j3', 'https://youtube.com/watch?v=x']);
		expect(all.map((r) => r.alreadyPresent)).toEqual([false, false, true, false]);
		const done = await run({ resource: 'queue', operation: 'getMany', statuses: ['done'], limit: 1 });
		expect(done.map((r) => r.jobId)).toEqual(['j1']);
		const one = await run({ resource: 'queue', operation: 'getMany', statuses: 'error', returnAll: true, splitIntoItems: false });
		expect((one[0].data as Array<{ jobId: string }>).map((r) => r.jobId)).toEqual(['j2']);
	});

	it('validates statuses and limit', async () => {
		expect((await runNodeError({ credentials: credentials(server), params: { resource: 'queue', operation: 'getMany', statuses: ['paused'] } })).message).toMatch(/Unknown status/);
		expect((await runNodeError({ credentials: credentials(server), params: { resource: 'queue', operation: 'getMany', limit: 0 } })).message).toMatch(/Limit must be an integer/);
		expect((await runNodeError({ credentials: credentials(server), params: { resource: 'queue', operation: 'getMany', limit: 1e9 } })).message).toMatch(/Limit must be an integer/);
	});

	it('Get State', async () => {
		server.paused = true;
		const [out] = await run({ resource: 'queue', operation: 'getState' });
		expect(out).toMatchObject({ paused: true, state: 'paused', can_control: false });
	});
});

describe('Resolve & Search', () => {
	it('Resolve URL', async () => {
		server.links.set('https://www.deezer.com/album/1', { kind: 'album', name: 'X', tracks: [] });
		const [out] = await run({ resource: 'search', operation: 'resolveUrl', url: 'https://www.deezer.com/album/1' });
		expect(out).toMatchObject({ kind: 'album', name: 'X' });
	});

	it('Search Songs', async () => {
		const out = await run({ resource: 'search', operation: 'searchSongs', query: 'daft punk' });
		expect(out[0].name).toBe('Result for daft punk');
	});

	it('Search (finder) as one item or split by type', async () => {
		const [all] = await run({ resource: 'search', operation: 'finderSearch', query: 'daft', limit: 10 });
		expect(Object.keys(all)).toEqual(['songs', 'albums', 'artists']);
		expect(server.requestsTo('GET', '/api/finder/search')[0].query.get('limit')).toBe('10');
		const artists = await run({ resource: 'search', operation: 'finderSearch', query: 'daft', resultType: 'artists' });
		expect(artists).toEqual([{ artist_id: '27', name: 'Daft Punk', limit: '50' }]);
		const err = await runNodeError({ credentials: credentials(server), params: { resource: 'search', operation: 'finderSearch', query: 'x', limit: 51 } });
		expect(err.message).toMatch(/Limit must be an integer between 1 and 50/);
	});

	it('Get Artist Albums with release types', async () => {
		const all = await run({ resource: 'search', operation: 'getArtistAlbums', artistId: '27' });
		expect(all.map((a) => a.release_type)).toEqual(['Album', 'Single', 'EP']);
		const eps = await run({ resource: 'search', operation: 'getArtistAlbums', artistId: '27', releaseTypes: ['EP', 'Album'] });
		expect(eps.map((a) => a.title)).toEqual(['Random Access Memories', 'Alive EP']);
		const err = await runNodeError({ credentials: credentials(server), params: { resource: 'search', operation: 'getArtistAlbums', artistId: '27/../x' } });
		expect(err.message).toMatch(/numeric Deezer ID/);
	});
});

describe('Library', () => {
	beforeEach(() => {
		server.albums = [
			{ title: 'Discovery', artist: 'Daft Punk', year: '2001', track_count: 14 },
			{ title: 'Moon Safari (Remastered)', artist: 'Air', year: '1998', track_count: 10 },
			{ title: 'Discovery', artist: 'Other Band', year: '2010', track_count: 9 },
		];
	});

	it('Get Summary, Albums, Artists, Playlists', async () => {
		expect((await run({ resource: 'library', operation: 'getSummary' }))[0]).toMatchObject({ tracks: 14 });
		expect(await run({ resource: 'library', operation: 'getAlbums', limit: 2 })).toHaveLength(2);
		expect((await run({ resource: 'library', operation: 'getArtists', returnAll: true }))[0]).toMatchObject({ name: 'Daft Punk' });
		expect((await run({ resource: 'library', operation: 'getPlaylists', returnAll: true }))[0]).toMatchObject({ name: 'Road trip', track_ids: ['trk1', 'trk2'] });
	});

	it('Get Tracks with filters and limit', async () => {
		const out = await run({ resource: 'library', operation: 'getTracks', trackFilters: { artist: 'Daft Punk' }, limit: 5 });
		expect(out.map((t) => t.title)).toEqual(['One More Time']);
		const req = server.requestsTo('GET', '/tracks')[0];
		expect(req.query.get('artist')).toBe('Daft Punk');
		expect(req.query.get('limit')).toBe('5');
		await run({ resource: 'library', operation: 'getTracks', returnAll: true });
		expect(server.requestsTo('GET', '/tracks')[1].query.get('limit')).toBeNull();
		await run({ resource: 'library', operation: 'getTracks', limit: 500 });
		expect(server.requestsTo('GET', '/tracks')[2].query.get('limit')).toBeNull();
	});

	it('Get Track encodes and validates the ID', async () => {
		expect((await run({ resource: 'library', operation: 'getTrack', trackId: 'trk1' }))[0]).toMatchObject({ title: 'One More Time' });
		const missing = await runNodeError({ credentials: credentials(server), params: { resource: 'library', operation: 'getTrack', trackId: 'nope' } });
		expect(missing.message).toBe('Downtify API error 404: Track not found');
		for (const evil of ['../../api/settings', '%2e%2e', '..', 'a/../b']) {
			const err = await runNodeError({ credentials: credentials(server), params: { resource: 'library', operation: 'getTrack', trackId: evil } });
			expect(err.message, evil).toMatch(/Track ID is not valid/);
		}
	});

	it('Find Album matches artist and title, ignoring case, accents and edition notes', async () => {
		const [hit] = await run({ resource: 'library', operation: 'findAlbum', artist: 'daft punk', title: 'DISCOVERY' });
		expect(hit).toMatchObject({ found: true, matchCount: 1, album: { artist: 'Daft Punk', year: '2001' } });
		const [edition] = await run({ resource: 'library', operation: 'findAlbum', artist: 'Air', title: 'Moon Safari' });
		expect(edition).toMatchObject({ found: true });
		const [strict] = await run({ resource: 'library', operation: 'findAlbum', artist: 'Air', title: 'Moon Safari', ignoreEdition: false });
		expect(strict).toMatchObject({ found: false, album: null });
		const [byTitle] = await run({ resource: 'library', operation: 'findAlbum', title: 'Discovery' });
		expect(byTitle).toMatchObject({ found: true, matchCount: 2 });
		const [feat] = await run({ resource: 'library', operation: 'findAlbum', artist: 'Daft Punk, Pharrell Williams', title: 'Discovery' });
		expect(feat).toMatchObject({ found: true, matchCount: 1 });
		const [miss] = await run({ resource: 'library', operation: 'findAlbum', artist: 'Daft Punk', title: 'Homework' });
		expect(miss).toMatchObject({ found: false, matchCount: 0 });
	});
});

describe('Playlist Monitor', () => {
	it('Get Many', async () => {
		const out = await run({ resource: 'monitor', operation: 'getMany', returnAll: true });
		expect(out).toEqual([{ id: 1, name: 'Discover Weekly', source: 'spotify', enabled: true }]);
	});
});

describe('Podcasts', () => {
	beforeEach(() => {
		server.shows = [{ id: 3, name: 'Tech Talk', episode_count: 2 }];
		server.episodes.set(3, [
			{ id: 31, show_id: 3, title: 'Ep 1', filename: 'Podcasts/Tech Talk/Ep 1.mp3', downloaded_at: '2026-11-01T10:00:00+00:00' },
			{ id: 32, show_id: 3, title: 'Ep 2', filename: null, downloaded_at: null },
		]);
	});

	it('Get Shows, Get Show, Get Episodes with filters', async () => {
		expect(await run({ resource: 'podcast', operation: 'getShows', returnAll: true })).toHaveLength(1);
		expect((await run({ resource: 'podcast', operation: 'getShow', showId: '3' }))[0]).toMatchObject({ name: 'Tech Talk' });
		expect(await run({ resource: 'podcast', operation: 'getEpisodes', showId: 3, returnAll: true })).toHaveLength(2);
		const notDownloaded = await run({ resource: 'podcast', operation: 'getEpisodes', showId: 3, returnAll: true, episodeFilters: { downloadState: 'notDownloaded', includeDismissed: true } });
		expect(notDownloaded.map((e) => e.id)).toEqual([32]);
		expect(server.requestsTo('GET', '/api/podcasts/shows/3/episodes')[1].query.get('include_dismissed')).toBe('true');
		const err = await runNodeError({ credentials: credentials(server), params: { resource: 'podcast', operation: 'getShow', showId: '3/../../settings' } });
		expect(err.message).toMatch(/Show ID must be a positive integer/);
	});

	it('Search and Resolve (preview only)', async () => {
		expect((await run({ resource: 'podcast', operation: 'search', query: 'tech', returnAll: true }))[0]).toMatchObject({ name: 'Podcast tech' });
		const [preview] = await run({ resource: 'podcast', operation: 'resolve', url: 'https://feeds.example/p.xml' });
		expect(preview).toMatchObject({ feed_url: 'https://feeds.example/p.xml', already_subscribed: false });
		expect(server.requestsTo('POST', '/api/podcasts/subscribe')).toHaveLength(0);
	});

	it('Download Episode waits for the file and refuses a paused queue', async () => {
		const [ep] = await run({ resource: 'podcast', operation: 'downloadEpisode', episodeId: '32' });
		expect(ep).toMatchObject({ id: 32, downloaded: true, filename: 'Podcasts/Show/Ep 2.mp3' });
		server.paused = true;
		const err = await runNodeError({ credentials: credentials(server), params: { resource: 'podcast', operation: 'downloadEpisode', episodeId: '31' } });
		expect(err.message).toMatch(/queue is paused/);
		expect(server.requestsTo('POST', '/api/podcasts/episodes/31/download')).toHaveLength(0);
	});

	it('Download Episode stops at its timeout', async () => {
		server.on('POST', '/api/podcasts/episodes/{id}/download', () => ({ delayMs: 3000, json: {} }));
		const started = Date.now();
		const err = await runNodeError({ credentials: credentials(server), params: { resource: 'podcast', operation: 'downloadEpisode', episodeId: '32', timeout: 1 } });
		expect(err.message).toMatch(/timed out after 1 s/);
		expect(Date.now() - started).toBeLessThan(2900);
		const big = await runNodeError({ credentials: credentials(server), params: { resource: 'podcast', operation: 'downloadEpisode', episodeId: '32', timeout: 90000 } });
		expect(big.message).toMatch(/Timeout must be an integer between 1 and 86400/);
	});
});

describe('Server', () => {
	it('Health, Version, Get Me', async () => {
		expect((await run({ resource: 'server', operation: 'health' }))[0]).toEqual({ status: 'ok', version: '3.8.1', healthy: true });
		expect((await run({ resource: 'server', operation: 'version' }))[0]).toEqual({ version: '3.8.1' });
		expect((await run({ resource: 'server', operation: 'getMe' }))[0]).toMatchObject({ user: { username: 'n8n', role: 'user' } });
	});

	it('Health reports an unavailable database clearly (Downtify 3.9+)', async () => {
		server.on('GET', '/api/health', () => ({ status: 503, json: { status: 'database_unavailable' } }));
		const err = await runNodeError({ credentials: credentials(server), params: { resource: 'server', operation: 'health' } });
		expect(err.message).toBe('Downtify is running but its database is unavailable (HTTP 503 database_unavailable)');
		expect(err.description).toMatch(/PostgreSQL/);
	});
});
