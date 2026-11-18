import type { IDataObject } from 'n8n-workflow';

import { data, type OperationContext, type ResourceHandlers } from '../../shared/engine';
import { findAlbum } from '../../shared/library';
import {
	assertQueueRunning,
	PAUSED_MESSAGE,
	songArtist,
	songTitle,
	waitForJobs,
	type JobOutcome,
	type WaitStop,
} from '../../shared/queue';
import {
	MAX_POLL_INTERVAL_SECONDS,
	MAX_RETRY_ROUNDS,
	MAX_TRACKS_PER_REQUEST,
	MAX_WAIT_SECONDS,
	MIN_POLL_INTERVAL_SECONDS,
	RESOLVE_TIMEOUT_MS,
	validateInteger,
	validateLink,
} from '../../shared/security';

const SUPPORTED_KINDS = ['track', 'album', 'playlist'];

interface BatchAnswer {
	job_ids?: unknown;
	count?: unknown;
}

export interface WaitSettings {
	pollIntervalMs: number;
	timeoutMs: number;
}

/** Validated also when set by expression. */
export function waitSettings(ctx: OperationContext, options: IDataObject, defaultTimeout = 3600): WaitSettings {
	return ctx.guard(() => ({
		pollIntervalMs:
			validateInteger(options.pollInterval ?? 5, 'Poll Interval', MIN_POLL_INTERVAL_SECONDS, MAX_POLL_INTERVAL_SECONDS) * 1000,
		timeoutMs: validateInteger(options.timeout ?? defaultTimeout, 'Timeout', 1, MAX_WAIT_SECONDS) * 1000,
	}));
}

/** POST /api/download/batch; returns the job IDs in the order of `songs` (duplicates collapsed). */
async function queueSongs(
	ctx: OperationContext,
	songs: IDataObject[],
	playlistUrl: string | undefined,
	generateM3u: boolean,
): Promise<Map<string, IDataObject>> {
	const body: IDataObject = { songs, generate_m3u: generateM3u };
	if (playlistUrl) body.playlist_url = playlistUrl;
	const answer = (await ctx.client.post<BatchAnswer>('/api/download/batch', body, { timeoutMs: RESOLVE_TIMEOUT_MS })) ?? {};
	const ids = Array.isArray(answer.job_ids) ? answer.job_ids : [];
	if (!ids.length) throw ctx.client.error('Downtify did not queue any track (no job IDs in the answer)');
	const jobs = new Map<string, IDataObject>();
	ids.forEach((raw, index) => {
		const id = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
		if (id === '' || jobs.has(id)) return;
		jobs.set(id, songs[index] ?? {});
	});
	return jobs;
}

function trackInfo(o: JobOutcome): IDataObject {
	return {
		jobId: o.jobId,
		title: songTitle(o.song),
		artist: songArtist(o.song),
		message: o.message || (o.status === 'removed' ? 'Removed from the Downtify queue' : ''),
	};
}

function pendingInfo(jobId: string, song: IDataObject, outcome?: JobOutcome): IDataObject {
	return { jobId, title: songTitle(song), artist: songArtist(song), status: outcome?.status ?? 'queued' };
}

export const downloadHandlers: ResourceHandlers = {
	downloadUrl: async (ctx) => {
		const url = ctx.guard(() => validateLink(ctx.str('url')));
		const wait = ctx.param<boolean>('waitForCompletion', true) !== false;
		const options = ctx.collection('options');
		const failOnError = options.failOnError !== false;
		const generateM3u = options.generateM3u !== false;
		const skipIfInLibrary = options.skipIfInLibrary === true;
		const retryRounds = ctx.guard(() => validateInteger(options.retryFailedTracks ?? 1, 'Retry Failed Tracks', 0, MAX_RETRY_ROUNDS));
		const settings = waitSettings(ctx, options);
		const startedAt = Date.now();

		const resolved = (await ctx.client.get<IDataObject>('/api/url/resolve', { url }, { timeoutMs: RESOLVE_TIMEOUT_MS })) ?? {};
		const kind = String(resolved.kind ?? '');
		if (!SUPPORTED_KINDS.includes(kind)) {
			throw ctx.client.error(
				kind === 'artist'
					? 'Artist links are not supported: use Resolve & Search > Get Artist Albums and download an album link'
					: `Unsupported link type "${kind.slice(0, 32)}"`,
			);
		}
		const tracks = (Array.isArray(resolved.tracks) ? resolved.tracks : []).filter(
			(t): t is IDataObject => !!t && typeof t === 'object' && !Array.isArray(t),
		);
		if (!tracks.length) throw ctx.client.error('The link has no downloadable tracks');
		if (tracks.length > MAX_TRACKS_PER_REQUEST) {
			throw ctx.client.error(`The link has ${tracks.length} tracks; at most ${MAX_TRACKS_PER_REQUEST} can be queued at once`);
		}
		const title = String(resolved.name ?? '');
		const artist = String(resolved.subtitle || (kind === 'playlist' ? '' : songArtist(tracks[0])));
		const summary: IDataObject = { url, kind, title, artist, totalTracks: tracks.length };

		if (skipIfInLibrary && kind === 'album') {
			const match = await findAlbum(ctx.client, artist, title);
			if (match.found) {
				return data({
					...summary,
					status: 'skipped',
					skipped: true,
					libraryAlbum: match.album,
					downloaded: 0,
					alreadyPresent: 0,
					failedCount: 0,
					failed: [],
					files: [],
					existingFiles: [],
					jobIds: [],
				});
			}
		}

		// A paused queue would never start the jobs
		await assertQueueRunning(ctx.client);
		const playlistUrl = kind === 'playlist' ? url : undefined;
		const jobs = await queueSongs(ctx, tracks, playlistUrl, kind === 'playlist' && generateM3u);
		const jobIds = [...jobs.keys()];
		const base: IDataObject = { ...summary, skipped: false, jobIds, queuedTracks: jobIds.length };
		if (!wait) return data({ ...base, status: 'queued' });

		const deadline = startedAt + settings.timeoutMs;
		const results = new Map<string, JobOutcome>();
		let toWait = jobs;
		let stop: WaitStop = 'completed';
		let retries = 0;
		for (;;) {
			const round = await waitForJobs(ctx.client, toWait, { pollIntervalMs: settings.pollIntervalMs, deadline });
			for (const [id, outcome] of round.outcomes) results.set(id, outcome);
			stop = round.stop;
			if (stop !== 'completed' || retries >= retryRounds) break;
			const failed = [...toWait.keys()].filter((id) => {
				const s = results.get(id)?.status;
				return s === 'error' || s === 'removed';
			});
			if (!failed.length || Date.now() >= deadline) break;
			retries++;
			await assertQueueRunning(ctx.client);
			// Same playlist folder, but no M3U: it would be rewritten with the retried tracks only
			toWait = await queueSongs(ctx, failed.map((id) => jobs.get(id) ?? results.get(id)?.song ?? {}), playlistUrl, false);
			for (const id of toWait.keys()) results.delete(id);
		}

		const outcomes = jobIds.map((id) => results.get(id));
		const done = outcomes.filter((o): o is JobOutcome => o?.status === 'done');
		const failed = outcomes.filter((o): o is JobOutcome => o?.status === 'error' || o?.status === 'removed');
		const pending = jobIds.filter((id) => {
			const s = results.get(id)?.status;
			return s === undefined || s === 'queued' || s === 'downloading';
		});
		const fresh = done.filter((o) => !o.alreadyPresent);
		const present = done.filter((o) => o.alreadyPresent);
		const status =
			stop === 'paused' ? 'paused' : stop === 'timeout' ? 'timeout' : failed.length ? 'completedWithErrors' : 'completed';
		const result: IDataObject = {
			...base,
			status,
			downloaded: fresh.length,
			alreadyPresent: present.length,
			failedCount: failed.length,
			failed: failed.map(trackInfo),
			pendingCount: pending.length,
			pending: pending.map((id) => pendingInfo(id, jobs.get(id) ?? {}, results.get(id))),
			files: fresh.map((o) => o.filename).filter((f): f is string => !!f),
			existingFiles: present.map((o) => o.filename).filter((f): f is string => !!f),
			retries,
			durationSeconds: Math.round((Date.now() - startedAt) / 1000),
		};

		if (failOnError) {
			if (stop === 'paused') {
				throw ctx.client.error(PAUSED_MESSAGE, `${pending.length} of ${jobIds.length} tracks are still waiting in the queue.`);
			}
			if (stop === 'timeout') {
				throw ctx.client.error(
					`Timed out after ${Math.round(settings.timeoutMs / 1000)} s: ${pending.length} of ${jobIds.length} tracks are not finished yet`,
					'The downloads keep running in Downtify. Increase the timeout or disable Fail On Error to get the partial summary.',
				);
			}
			if (failed.length) {
				const lines = failed.slice(0, 10).map((o) => {
					const info = trackInfo(o);
					return `${String(info.artist)} - ${String(info.title)}: ${String(info.message)}`;
				});
				throw ctx.client.error(
					`${failed.length} of ${jobIds.length} tracks failed to download`,
					lines.join('\n') + (failed.length > 10 ? `\n… and ${failed.length - 10} more` : ''),
				);
			}
		}
		return data(result);
	},
};

