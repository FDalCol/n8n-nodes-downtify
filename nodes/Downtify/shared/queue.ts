/**
 * Download queue helpers (Downtify 3.8.1, unchanged in 3.11.0):
 *
 * - a job's ID is the song's `song_id`, else its `url` (`_register_job`); `GET /api/queue`
 *   rows carry no ID of their own, so it is read back from `row.song`;
 * - statuses are `queued`, `downloading`, `done` and `error`;
 * - with "Download again if the file exists" off, a song already in the library ends `done`
 *   with the message "Already in library", "Already on disk" or "Already downloaded";
 * - a job with the same ID that already finished is reset to `queued` by the new request
 *   before the response, an active one is shared: polling the returned IDs is safe;
 * - while the queue is paused, jobs stay `queued` and only an admin browser can resume it.
 */
import type { IDataObject } from 'n8n-workflow';

import { MAX_POLL_ITERATIONS } from './security';
import type { DowntifyClient } from './transport';

export type JobStatus = 'queued' | 'downloading' | 'done' | 'error';

export const TERMINAL_STATUSES: readonly string[] = ['done', 'error'];

const ALREADY_PRESENT = /^Already (in library|on disk|downloaded)$/i;

/** The queue key of a song, exactly as Downtify computes it. */
export function songJobId(song: unknown): string | undefined {
	if (!song || typeof song !== 'object') return undefined;
	const s = song as IDataObject;
	const id = s.song_id || s.url;
	if (typeof id === 'string' && id !== '') return id;
	if (typeof id === 'number') return String(id);
	return undefined;
}

export function rowJobId(row: IDataObject): string | undefined {
	return songJobId(row.song);
}

export function isTerminal(status: unknown): boolean {
	return typeof status === 'string' && TERMINAL_STATUSES.includes(status);
}

export function isAlreadyPresent(row: IDataObject): boolean {
	return row.status === 'done' && typeof row.message === 'string' && ALREADY_PRESENT.test(row.message.trim());
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

export function songTitle(song: unknown): string {
	const s = (song ?? {}) as IDataObject;
	return str(s.name || s.title);
}

export function songArtist(song: unknown): string {
	const s = (song ?? {}) as IDataObject;
	if (Array.isArray(s.artists) && s.artists.length) return s.artists.map((a) => str(a)).filter(Boolean).join(', ');
	return str(s.artist);
}

export function songAlbum(song: unknown): string {
	const s = (song ?? {}) as IDataObject;
	return str(s.album_name || s.album);
}

/** The album artist of a song: `album_artist`, else the first credited artist. */
export function songAlbumArtist(song: unknown): string {
	const s = (song ?? {}) as IDataObject;
	const albumArtist = str(s.album_artist).trim();
	if (albumArtist && albumArtist.toLowerCase() !== 'various artists') return albumArtist;
	if (Array.isArray(s.artists) && s.artists.length) return str(s.artists[0]);
	return str(s.artist).split(',')[0].trim();
}

/** A queue row with its job ID and the "already present" flag added. */
export function describeRow(row: IDataObject): IDataObject {
	return { jobId: rowJobId(row) ?? null, alreadyPresent: isAlreadyPresent(row), ...row };
}

export async function getQueue(client: DowntifyClient): Promise<IDataObject[]> {
	const rows = await client.get<unknown>('/api/queue');
	if (!Array.isArray(rows)) throw client.error('Unexpected answer from GET /api/queue (not a list)');
	return rows.filter((r): r is IDataObject => !!r && typeof r === 'object' && !Array.isArray(r));
}

export interface QueueState {
	paused: boolean;
	state: string;
	active: number;
}

export async function getQueueState(client: DowntifyClient): Promise<QueueState & IDataObject> {
	const state = (await client.get<IDataObject>('/api/queue/state')) ?? {};
	return {
		...state,
		paused: state.paused === true,
		state: str(state.state),
		active: Number(state.active ?? 0) || 0,
	};
}

export const PAUSED_MESSAGE =
	'The Downtify download queue is paused. A device token cannot resume it: an admin must resume the queue in the Downtify web interface.';

/** Fails with a clear message when the queue is paused (nothing would start). */
export async function assertQueueRunning(client: DowntifyClient): Promise<void> {
	const state = await getQueueState(client);
	if (state.paused) throw client.error(PAUSED_MESSAGE);
}

export interface JobOutcome {
	jobId: string;
	song: IDataObject;
	status: JobStatus | 'removed';
	message: string;
	filename: string | null;
	provider: string;
	alreadyPresent: boolean;
}

export type WaitStop = 'completed' | 'timeout' | 'paused';

export interface WaitOptions {
	pollIntervalMs: number;
	/** Absolute time (ms since epoch) after which waiting stops. */
	deadline: number;
}

/** A job missing from the queue this many polls in a row was removed by someone else. */
const MISSING_POLLS_BEFORE_REMOVED = 2;

/**
 * Polls `GET /api/queue` until every job is `done` or `error` (or was removed from the
 * queue), the deadline passes, the queue is paused with jobs still waiting, or the
 * execution is cancelled (which throws).
 */
export async function waitForJobs(
	client: DowntifyClient,
	jobs: Map<string, IDataObject>,
	options: WaitOptions,
): Promise<{ stop: WaitStop; outcomes: Map<string, JobOutcome> }> {
	const outcomes = new Map<string, JobOutcome>();
	const misses = new Map<string, number>();
	const outcome = (jobId: string, row: IDataObject | undefined, status: JobOutcome['status']): JobOutcome => ({
		jobId,
		song: (row?.song as IDataObject | undefined) ?? jobs.get(jobId) ?? {},
		status,
		message: str(row?.message),
		filename: typeof row?.filename === 'string' && row.filename !== '' ? row.filename : null,
		provider: str(row?.provider),
		alreadyPresent: row ? isAlreadyPresent(row) : false,
	});

	for (let iteration = 0; iteration < MAX_POLL_ITERATIONS; iteration++) {
		client.throwIfCancelled();
		const rows = await getQueue(client);
		const byId = new Map<string, IDataObject>();
		for (const row of rows) {
			const id = rowJobId(row);
			if (id !== undefined && jobs.has(id)) byId.set(id, row);
		}
		let waiting = false;
		let anyQueued = false;
		for (const jobId of jobs.keys()) {
			if (outcomes.has(jobId) && isTerminal(outcomes.get(jobId)!.status)) continue;
			if (outcomes.get(jobId)?.status === 'removed') continue;
			const row = byId.get(jobId);
			if (!row) {
				const n = (misses.get(jobId) ?? 0) + 1;
				misses.set(jobId, n);
				if (n >= MISSING_POLLS_BEFORE_REMOVED) {
					outcomes.set(jobId, { ...outcome(jobId, undefined, 'removed'), message: 'Removed from the Downtify queue' });
				} else {
					waiting = true;
				}
				continue;
			}
			misses.delete(jobId);
			const status = str(row.status) as JobStatus;
			outcomes.set(jobId, outcome(jobId, row, status === 'done' || status === 'error' || status === 'downloading' ? status : 'queued'));
			if (!isTerminal(status)) {
				waiting = true;
				if (status !== 'downloading') anyQueued = true;
			}
		}
		if (!waiting) return { stop: 'completed', outcomes };
		if (anyQueued && (await getQueueState(client)).paused) return { stop: 'paused', outcomes };
		const remaining = options.deadline - Date.now();
		if (remaining <= 0) return { stop: 'timeout', outcomes };
		await client.pause(Math.min(options.pollIntervalMs, remaining));
	}
	return { stop: 'timeout', outcomes };
}
