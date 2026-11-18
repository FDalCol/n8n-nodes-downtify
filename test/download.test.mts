import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeDowntify, song } from './helpers/fakeDowntify.mts';
import { credentials, runNodeError, runNodeJson, type Params } from './helpers/harness.mts';

let server: FakeDowntify;

beforeAll(async () => {
	server = await new FakeDowntify().start();
});
afterAll(async () => {
	await server.stop();
});
beforeEach(() => server.reset());

const TRACK_URL = 'https://open.spotify.com/track/t1';
const ALBUM_URL = 'https://www.deezer.com/album/302127';
const PLAYLIST_URL = 'https://open.spotify.com/playlist/pl1';

const albumTracks = [song('a1', 'One More Time', 'Daft Punk', 'Discovery'), song('a2', 'Aerodynamic', 'Daft Punk', 'Discovery'), song('a3', 'Digital Love', 'Daft Punk', 'Discovery')];

function setupLinks() {
	server.links.set(TRACK_URL, { kind: 'track', name: 'Song One', subtitle: 'Artist One', tracks: [song('t1', 'Song One', 'Artist One', 'Single One')] });
	server.links.set(ALBUM_URL, { kind: 'album', name: 'Discovery', subtitle: 'Daft Punk', tracks: albumTracks });
	server.links.set(PLAYLIST_URL, {
		kind: 'playlist',
		name: 'Road Trip',
		subtitle: '',
		tracks: [song('p1', 'First', 'A'), song('p2', 'Second', 'B'), song('p1', 'First', 'A')],
	});
	server.links.set('https://open.spotify.com/artist/ar1', { kind: 'artist', name: 'Daft Punk', tracks: [], albums: [{ title: 'Discovery' }] });
}

const params = (url: string, options: Params = {}, extra: Params = {}): Params => ({
	resource: 'download',
	operation: 'downloadUrl',
	url,
	waitForCompletion: true,
	options: { pollInterval: 1, ...options },
	...extra,
});

describe('Download URL', () => {
	beforeEach(setupLinks);

	it('downloads a track and returns the summary', async () => {
		const [out] = await runNodeJson({ credentials: credentials(server), params: params(TRACK_URL) });
		expect(out).toMatchObject({
			url: TRACK_URL,
			kind: 'track',
			title: 'Song One',
			artist: 'Artist One',
			status: 'completed',
			totalTracks: 1,
			downloaded: 1,
			alreadyPresent: 0,
			failedCount: 0,
			failed: [],
			files: ['Artist One - Song One.mp3'],
			jobIds: ['t1'],
			skipped: false,
		});
		const batch = server.requestsTo('POST', '/api/download/batch')[0].json as Record<string, unknown>;
		expect(batch.generate_m3u).toBe(false);
		expect(batch.playlist_url).toBeUndefined();
		expect(server.requestsTo('GET', '/api/url/resolve')[0].query.get('url')).toBe(TRACK_URL);
	});

	it('downloads an album, counting tracks already present', async () => {
		server.plan.set('a2', ['present']);
		const [out] = await runNodeJson({ credentials: credentials(server), params: params(ALBUM_URL) });
		expect(out).toMatchObject({ kind: 'album', title: 'Discovery', artist: 'Daft Punk', totalTracks: 3, downloaded: 2, alreadyPresent: 1, status: 'completed' });
		expect(out.existingFiles).toEqual(['Daft Punk - Aerodynamic.mp3']);
		expect(out.files).toHaveLength(2);
		const batch = server.requestsTo('POST', '/api/download/batch')[0].json as Record<string, unknown>;
		expect(batch.generate_m3u).toBe(false);
		expect(batch.playlist_url).toBeUndefined();
	});

	it('downloads a playlist with playlist_url and M3U, collapsing duplicate job IDs', async () => {
		const [out] = await runNodeJson({ credentials: credentials(server), params: params(PLAYLIST_URL) });
		expect(out).toMatchObject({ kind: 'playlist', title: 'Road Trip', totalTracks: 3, queuedTracks: 2, downloaded: 2, jobIds: ['p1', 'p2'] });
		const batch = server.requestsTo('POST', '/api/download/batch')[0].json as Record<string, unknown>;
		expect(batch.playlist_url).toBe(PLAYLIST_URL);
		expect(batch.generate_m3u).toBe(true);
		await runNodeJson({ credentials: credentials(server), params: params(PLAYLIST_URL, { generateM3u: false }) });
		expect((server.requestsTo('POST', '/api/download/batch')[1].json as Record<string, unknown>).generate_m3u).toBe(false);
	});

	it('returns right after queueing without Wait For Completion', async () => {
		const [out] = await runNodeJson({ credentials: credentials(server), params: params(ALBUM_URL, {}, { waitForCompletion: false }) });
		expect(out).toMatchObject({ status: 'queued', jobIds: ['a1', 'a2', 'a3'] });
		expect(server.requestsTo('GET', '/api/queue')).toHaveLength(0);
	});

	it('rejects artist links and links without tracks', async () => {
		const err = await runNodeError({ credentials: credentials(server), params: params('https://open.spotify.com/artist/ar1') });
		expect(err.message).toMatch(/Artist links are not supported/);
		const bad = await runNodeError({ credentials: credentials(server), params: params('https://example.com/unknown') });
		expect(bad.message).toBe('Downtify API error 400: Invalid URL');
		const notUrl = await runNodeError({ credentials: credentials(server), params: params('javascript:alert(1)') });
		expect(notUrl.message).toMatch(/must start with https/);
		expect(server.requestsTo('POST', '/api/download/batch')).toHaveLength(0);
	});

	it('fails with the failed tracks when Fail On Error is on (no retry)', async () => {
		server.plan.set('a3', ['error']);
		const err = await runNodeError({ credentials: credentials(server), params: params(ALBUM_URL, { retryFailedTracks: 0 }) });
		expect(err.message).toBe('1 of 3 tracks failed to download');
		expect(err.description).toContain('Daft Punk - Digital Love: Error: no audio match found');
	});

	it('returns the summary with the failed tracks when Fail On Error is off', async () => {
		server.plan.set('a3', ['error', 'error']);
		const [out] = await runNodeJson({ credentials: credentials(server), params: params(ALBUM_URL, { failOnError: false }) });
		expect(out).toMatchObject({
			status: 'completedWithErrors',
			downloaded: 2,
			failedCount: 1,
			retries: 1,
			failed: [{ jobId: 'a3', title: 'Digital Love', artist: 'Daft Punk', message: 'Error: no audio match found' }],
		});
		// The retry re-queues only the failed song, without M3U
		const batches = server.requestsTo('POST', '/api/download/batch');
		expect(batches).toHaveLength(2);
		expect((batches[1].json as { songs: Array<{ song_id: string }> }).songs.map((s) => s.song_id)).toEqual(['a3']);
	});

	it('retries failed tracks and succeeds on the second attempt', async () => {
		server.plan.set('p2', ['error', 'done']);
		const [out] = await runNodeJson({ credentials: credentials(server), params: params(PLAYLIST_URL) });
		expect(out).toMatchObject({ status: 'completed', downloaded: 2, failedCount: 0, retries: 1 });
		const retry = server.requestsTo('POST', '/api/download/batch')[1].json as Record<string, unknown>;
		expect(retry.playlist_url).toBe(PLAYLIST_URL);
		expect(retry.generate_m3u).toBe(false);
	});

	it('stops at the timeout (error, or summary with pending tracks)', async () => {
		server.plan.set('a1', ['stuck']);
		const started = Date.now();
		const err = await runNodeError({ credentials: credentials(server), params: params(ALBUM_URL, { timeout: 2 }) });
		expect(err.message).toMatch(/^Timed out after 2 s: 1 of 3 tracks are not finished yet/);
		expect(Date.now() - started).toBeLessThan(6000);
		const [out] = await runNodeJson({ credentials: credentials(server), params: params(ALBUM_URL, { timeout: 2, failOnError: false }) });
		expect(out).toMatchObject({ status: 'timeout', pendingCount: 1, pending: [{ jobId: 'a1', status: 'downloading' }] });
	});

	it('stops when the execution is cancelled', async () => {
		server.plan.set('a1', ['stuck']);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 1200);
		const started = Date.now();
		const err = await runNodeError({ credentials: credentials(server), params: params(ALBUM_URL, { pollInterval: 30 }), cancelSignal: controller.signal });
		expect(err.message).toMatch(/cancelled/i);
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it('validates poll interval, timeout and retries also from expressions', async () => {
		for (const options of [{ pollInterval: 0 }, { timeout: 86401 }, { retryFailedTracks: 6 }, { pollInterval: 'abc' }]) {
			const err = await runNodeError({ credentials: credentials(server), params: params(ALBUM_URL, options) });
			expect(err.message).toMatch(/must be an integer between/);
		}
		expect(server.requests).toHaveLength(0);
	});
});

describe('paused queue', () => {
	beforeEach(setupLinks);

	it('refuses to queue when the queue is paused', async () => {
		server.paused = true;
		const err = await runNodeError({ credentials: credentials(server), params: params(ALBUM_URL) });
		expect(err.message).toMatch(/download queue is paused/);
		expect(err.message).toMatch(/admin must resume/);
		expect(server.requestsTo('POST', '/api/download/batch')).toHaveLength(0);
	});

	it('stops waiting when the queue gets paused with tracks still queued', async () => {
		server.on('POST', '/api/download/batch', (req) => {
			const ids = server.register((req.json as { songs: Array<Record<string, unknown>> }).songs);
			server.paused = true;
			return { json: { job_ids: ids, count: ids.length } };
		});
		const err = await runNodeError({ credentials: credentials(server), params: params(ALBUM_URL) });
		expect(err.message).toMatch(/download queue is paused/);
		expect(err.description).toBe('3 of 3 tracks are still waiting in the queue.');
		server.paused = false;
		server.queue.clear();
		const [out] = await runNodeJson({ credentials: credentials(server), params: params(ALBUM_URL, { failOnError: false }) });
		expect(out).toMatchObject({ status: 'paused', pendingCount: 3 });
	});
});

describe('jobs whose IDs are already in the queue', () => {
	beforeEach(setupLinks);

	it('a finished job with the same ID is reset and waited for again (not taken as done)', async () => {
		server.addJob(albumTracks[0], 'done', { message: 'Done', filename: 'old/file.mp3' });
		server.addJob(albumTracks[1], 'error', { message: 'Error: old failure' });
		server.addJob(song('other', 'Other', 'Somebody'), 'done');
		const [out] = await runNodeJson({ credentials: credentials(server), params: params(ALBUM_URL) });
		expect(out).toMatchObject({ status: 'completed', downloaded: 3, failedCount: 0, jobIds: ['a1', 'a2', 'a3'] });
		expect(out.files).not.toContain('old/file.mp3');
		// The unrelated job is not part of the summary
		expect(JSON.stringify(out)).not.toContain('Somebody');
	});

	it('an active job with the same ID is shared and waited for', async () => {
		server.addJob(albumTracks[2], 'downloading');
		const [out] = await runNodeJson({ credentials: credentials(server), params: params(ALBUM_URL) });
		expect(out).toMatchObject({ status: 'completed', downloaded: 3, jobIds: ['a1', 'a2', 'a3'] });
	});

	it('a job removed from the queue by someone else counts as failed', async () => {
		server.on('GET', '/api/queue', () => {
			server.tick();
			server.queue.delete('a2');
			return { json: [...server.queue.values()] };
		});
		const [out] = await runNodeJson({ credentials: credentials(server), params: params(ALBUM_URL, { failOnError: false, retryFailedTracks: 0 }) });
		expect(out).toMatchObject({ failedCount: 1, failed: [{ jobId: 'a2', message: 'Removed from the Downtify queue' }] });
	});
});

describe('Skip If In Library', () => {
	beforeEach(setupLinks);

	it('queues nothing when the album is already in the library', async () => {
		server.albums = [{ title: 'Discovery (Deluxe Edition)', artist: 'Daft Punk', year: '2001', track_count: 14 }];
		const [out] = await runNodeJson({ credentials: credentials(server), params: params(ALBUM_URL, { skipIfInLibrary: true }) });
		expect(out).toMatchObject({ status: 'skipped', skipped: true, totalTracks: 3, downloaded: 0, jobIds: [] });
		expect((out.libraryAlbum as Record<string, unknown>).title).toBe('Discovery (Deluxe Edition)');
		expect(server.requestsTo('POST', '/api/download/batch')).toHaveLength(0);
	});

	it('downloads when the album is missing, and ignores the option for playlists', async () => {
		server.albums = [{ title: 'Homework', artist: 'Daft Punk' }];
		const [album] = await runNodeJson({ credentials: credentials(server), params: params(ALBUM_URL, { skipIfInLibrary: true }) });
		expect(album).toMatchObject({ status: 'completed', skipped: false });
		server.albums = [{ title: 'Road Trip', artist: '' }];
		const [playlist] = await runNodeJson({ credentials: credentials(server), params: params(PLAYLIST_URL, { skipIfInLibrary: true }) });
		expect(playlist).toMatchObject({ status: 'completed', skipped: false });
		expect(server.requestsTo('GET', '/api/library/albums')).toHaveLength(1);
	});
});
