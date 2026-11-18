import type { IDataObject } from 'n8n-workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { stateKey } from '../nodes/DowntifyTrigger/DowntifyTrigger.node';
import { FakeDowntify, song } from './helpers/fakeDowntify.mts';
import { credentials, poll, type Params } from './helpers/harness.mts';

let server: FakeDowntify;

beforeAll(async () => {
	server = await new FakeDowntify().start();
});
afterAll(async () => {
	await server.stop();
});
beforeEach(() => {
	server.reset();
	server.advance = false;
});

const run = (params: Params, staticData: IDataObject, mode: 'manual' | 'trigger' = 'trigger') =>
	poll({ credentials: credentials(server), params, staticData, mode });

const one = song('d1', 'One More Time', 'Daft Punk', 'Discovery');
const two = song('d2', 'Aerodynamic', 'Daft Punk', 'Discovery');
const air = song('m1', 'La femme d argent', 'Air', 'Moon Safari');

describe('Download Finished / Download Failed', () => {
	it('first run returns nothing, later runs fire once per job and status', async () => {
		const data: IDataObject = {};
		server.addJob(one, 'done');
		expect(await run({ event: 'downloadFinished' }, data)).toBeNull();
		server.addJob(two, 'done');
		server.addJob(air, 'error', { message: 'Error: boom' });
		const fired = await run({ event: 'downloadFinished' }, data);
		expect(fired).toHaveLength(1);
		expect(fired![0]).toMatchObject({ event: 'downloadFinished', jobId: 'd2', title: 'Aerodynamic', artist: 'Daft Punk', album: 'Discovery', filename: 'Daft Punk - Aerodynamic.mp3' });
		expect(await run({ event: 'downloadFinished' }, data)).toBeNull();
	});

	it('fires again when the same track is downloaded again (dedupe by job ID + status)', async () => {
		const data: IDataObject = {};
		server.addJob(one, 'done');
		await run({ event: 'downloadFinished' }, data);
		server.queue.get('d1')!.status = 'queued';
		expect(await run({ event: 'downloadFinished' }, data)).toBeNull();
		server.queue.get('d1')!.status = 'done';
		expect((await run({ event: 'downloadFinished' }, data))!.map((i) => i.jobId)).toEqual(['d1']);
	});

	it('Download Failed fires for errors only, with the message', async () => {
		const data: IDataObject = {};
		await run({ event: 'downloadFailed' }, data);
		server.addJob(one, 'done');
		server.addJob(air, 'error', { message: 'Error: no audio match found' });
		const fired = await run({ event: 'downloadFailed' }, data);
		expect(fired).toEqual([expect.objectContaining({ event: 'downloadFailed', jobId: 'm1', status: 'error', message: 'Error: no audio match found' })]);
	});

	it('filters by artist and album and can skip tracks already present', async () => {
		const data: IDataObject = {};
		await run({ event: 'downloadFinished', filters: { artist: 'daft' } }, data);
		server.addJob(one, 'done');
		server.addJob(air, 'done');
		server.addJob(two, 'done', { message: 'Already in library' });
		const fired = await run({ event: 'downloadFinished', filters: { artist: 'daft', album: 'discov' } }, data);
		expect(fired!.map((i) => [i.jobId, i.alreadyPresent])).toEqual([
			['d1', false],
			['d2', true],
		]);
		const data2: IDataObject = {};
		await run({ event: 'downloadFinished', includeAlreadyPresent: false }, data2);
		server.queue.get('d2')!.status = 'queued';
		await run({ event: 'downloadFinished', includeAlreadyPresent: false }, data2);
		server.queue.get('d2')!.status = 'done';
		expect(await run({ event: 'downloadFinished', includeAlreadyPresent: false }, data2)).toBeNull();
	});

	it('test mode returns a real sample and does not change the state', async () => {
		server.addJob(one, 'done');
		server.addJob(two, 'done');
		const data: IDataObject = {};
		const sample = await run({ event: 'downloadFinished' }, data, 'manual');
		expect(sample).toEqual([expect.objectContaining({ jobId: 'd2', event: 'downloadFinished' })]);
		expect(data).toEqual({ event: 'downloadFinished' });
		expect(await run({ event: 'downloadFailed' }, {}, 'manual')).toBeNull();
	});

	it('keeps the state small: hashed keys, only jobs still in the queue', async () => {
		const data: IDataObject = {};
		const long = song('x'.repeat(5000), 'Long', 'A');
		server.addJob(long, 'done');
		server.addJob(one, 'done');
		await run({ event: 'downloadFinished' }, data);
		const seen = data.seen as string[];
		expect(seen).toHaveLength(2);
		expect(seen.every((k) => k.length < 32)).toBe(true);
		expect(seen).toContain(`${stateKey('d1')}|done`);
		server.queue.delete('d1');
		await run({ event: 'downloadFinished' }, data);
		expect(data.seen).toHaveLength(1);
	});

	it('resets the state when the event changes', async () => {
		const data: IDataObject = {};
		server.addJob(one, 'done');
		await run({ event: 'downloadFinished' }, data);
		expect(await run({ event: 'downloadFailed' }, data)).toBeNull();
		expect(data.event).toBe('downloadFailed');
	});
});

describe('Batch Finished', () => {
	it('fires when every job of an album has finished, with counts', async () => {
		const data: IDataObject = {};
		server.addJob(one, 'downloading');
		server.addJob(two, 'queued');
		server.addJob(air, 'done');
		expect(await run({ event: 'batchFinished' }, data)).toBeNull();
		Object.assign(server.queue.get('d1')!, { status: 'done', filename: 'Daft Punk - One More Time.mp3' });
		expect(await run({ event: 'batchFinished' }, data)).toBeNull();
		Object.assign(server.queue.get('d2')!, { status: 'error', message: 'Error: boom' });
		const fired = await run({ event: 'batchFinished' }, data);
		expect(fired).toHaveLength(1);
		expect(fired![0]).toMatchObject({
			event: 'batchFinished',
			album: 'Discovery',
			artist: 'Daft Punk',
			total: 2,
			downloaded: 1,
			alreadyPresent: 0,
			failedCount: 1,
			failed: [{ jobId: 'd2', title: 'Aerodynamic', artist: 'Daft Punk', message: 'Error: boom' }],
			files: ['Daft Punk - One More Time.mp3'],
			jobIds: ['d1', 'd2'],
		});
		// Moon Safari was already finished when the trigger started watching: no event
		expect(await run({ event: 'batchFinished' }, data)).toBeNull();
	});

	it('filters by artist and returns a sample in test mode', async () => {
		const data: IDataObject = {};
		server.addJob(one, 'queued');
		server.addJob(air, 'queued');
		await run({ event: 'batchFinished', filters: { artist: 'air' } }, data);
		server.queue.get('d1')!.status = 'done';
		server.queue.get('m1')!.status = 'done';
		const fired = await run({ event: 'batchFinished', filters: { artist: 'air' } }, data);
		expect(fired!.map((i) => i.album)).toEqual(['Moon Safari']);
		const sample = await run({ event: 'batchFinished' }, {}, 'manual');
		expect(sample![0]).toMatchObject({ event: 'batchFinished' });
	});
});

describe('New Podcast Episode Downloaded', () => {
	beforeEach(() => {
		server.shows = [
			{ id: 3, name: 'Tech Talk' },
			{ id: 4, name: 'News' },
		];
		server.episodes.set(3, [{ id: 31, title: 'Old', filename: 'Podcasts/Tech Talk/Old.mp3', downloaded_at: '2026-01-01T00:00:00+00:00' }]);
		server.episodes.set(4, [{ id: 41, title: 'Pending', filename: null, downloaded_at: null }]);
	});

	it('fires for episodes downloaded after activation, once', async () => {
		const data: IDataObject = {};
		expect(await run({ event: 'podcastEpisodeDownloaded' }, data)).toBeNull();
		Object.assign(server.episodes.get(4)![0], { filename: 'Podcasts/News/Pending.mp3', downloaded_at: new Date(Date.now() + 1000).toISOString() });
		const fired = await run({ event: 'podcastEpisodeDownloaded' }, data);
		expect(fired).toEqual([
			expect.objectContaining({ event: 'podcastEpisodeDownloaded', showId: 4, show: 'News', episodeId: 41, title: 'Pending', filename: 'Podcasts/News/Pending.mp3' }),
		]);
		expect(await run({ event: 'podcastEpisodeDownloaded' }, data)).toBeNull();
	});

	it('limits the shows read per poll and filters by show ID', async () => {
		const data: IDataObject = {};
		await run({ event: 'podcastEpisodeDownloaded', showIds: '4', maxShows: 1 }, data);
		expect(server.requestsTo('GET', '/api/podcasts/shows/3/episodes')).toHaveLength(0);
		expect(server.requestsTo('GET', '/api/podcasts/shows/4/episodes')).toHaveLength(1);
		await expect(run({ event: 'podcastEpisodeDownloaded', maxShows: 501 }, {})).rejects.toThrow(/Max Shows Per Poll must be an integer/);
		await expect(run({ event: 'podcastEpisodeDownloaded', showIds: '1,../x' }, {})).rejects.toThrow(/Show IDs must be positive integers/);
	});

	it('test mode returns the most recent downloaded episode', async () => {
		const sample = await run({ event: 'podcastEpisodeDownloaded' }, {}, 'manual');
		expect(sample).toEqual([expect.objectContaining({ episodeId: 31, title: 'Old' })]);
	});
});

describe('errors', () => {
	it('redacts the token and reports API errors', async () => {
		server.on('GET', '/api/queue', (req) => ({ status: 500, json: { detail: `boom ${String(req.headers.authorization)}` } }));
		const err = await run({ event: 'downloadFinished' }, {}).catch((e: Error) => e);
		expect((err as Error).message).toMatch(/^Downtify API error 500: boom Bearer \[REDACTED\]$/);
	});
});
