import {
	NodeConnectionTypes,
	NodeOperationError,
	type ICredentialDataDecryptedObject,
	type IDataObject,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type IPollFunctions,
} from 'n8n-workflow';

import { normalizeText } from '../Downtify/shared/library';
import {
	getQueue,
	isAlreadyPresent,
	isTerminal,
	rowJobId,
	songAlbum,
	songAlbumArtist,
	songArtist,
	songTitle,
} from '../Downtify/shared/queue';
import { signInIdentity } from '../Downtify/shared/auth';
import { MAX_STATE_ENTRIES, redactString, stateKey, validateInteger } from '../Downtify/shared/security';
import { CREDENTIAL_NAME, DowntifyClient, type SignInFailure } from '../Downtify/shared/transport';

export { stateKey };

type EventName = 'downloadFinished' | 'downloadFailed' | 'batchFinished' | 'podcastEpisodeDownloaded';

interface TriggerState {
	event?: EventName;
	initialized?: boolean;
	activatedAt?: string;
	/** Dedupe keys: hashed job ID + status, or podcast episode + download time. */
	seen?: string[];
	/** Hashed album keys that had unfinished jobs at the last poll. */
	activeAlbums?: string[];
	/** Sign-ins paused after a 401 or 429 (Username & Password). */
	signInPause?: SignInPause;
}

/** Hashes only: never the password. */
interface SignInPause {
	status: 401 | 429;
	account: string;
	session: string;
	/** 429: when Downtify accepts sign-ins again (ISO date). */
	until?: string;
	/** The error was already reported for this status and identity. */
	reported: boolean;
}

/** Used when a 429 has no Retry-After header. */
const DEFAULT_SIGN_IN_WAIT_SECONDS = 60;

/** Upper bound for a Retry-After wait. */
const MAX_SIGN_IN_WAIT_SECONDS = 24 * 60 * 60;

/**
 * A wrong password (401) is not retried until the credential changes; a 429 waits as long as
 * Downtify asks. Otherwise every poll would sign in again and keep Downtify's per-address
 * sign-in lockout active, also for other users.
 */
function signInPaused(pause: SignInPause, raw: ICredentialDataDecryptedObject, now: number): boolean {
	const identity = signInIdentity(raw);
	if (!identity || identity.account !== pause.account) return false;
	if (pause.status === 401) return identity.session === pause.session;
	return pause.until !== undefined && now < Date.parse(pause.until);
}

function pauseAfter(failure: SignInFailure, raw: ICredentialDataDecryptedObject, previous: SignInPause | undefined, now: number): SignInPause | undefined {
	const identity = signInIdentity(raw);
	if (!identity || (failure.signInStatus !== 401 && failure.signInStatus !== 429)) return undefined;
	const status = failure.signInStatus;
	const wait = Math.min(failure.retryAfterSeconds ?? DEFAULT_SIGN_IN_WAIT_SECONDS, MAX_SIGN_IN_WAIT_SECONDS);
	const reported =
		previous !== undefined &&
		previous.status === status &&
		previous.account === identity.account &&
		previous.session === identity.session;
	return {
		status,
		account: identity.account,
		session: identity.session,
		until: status === 429 ? new Date(now + wait * 1000).toISOString() : undefined,
		reported,
	};
}

interface Snapshot {
	items: IDataObject[];
	sample: IDataObject | undefined;
}

const MAX_SHOWS = 500;

function csvList(value: unknown): string[] {
	return String(value ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Case and accent insensitive "contains" filter; an empty filter matches everything. */
function matches(filter: unknown, ...values: string[]): boolean {
	const wanted = normalizeText(filter);
	if (wanted === '') return true;
	return values.some((v) => normalizeText(v).includes(wanted));
}

function jobItem(event: EventName, row: IDataObject): IDataObject {
	const song = (row.song ?? {}) as IDataObject;
	return {
		event,
		jobId: rowJobId(row) ?? null,
		status: row.status,
		title: songTitle(song),
		artist: songArtist(song),
		album: songAlbum(song),
		filename: row.filename ?? null,
		message: row.message ?? '',
		provider: row.provider ?? '',
		alreadyPresent: isAlreadyPresent(row),
		songId: song.song_id ?? null,
		songUrl: song.url ?? null,
		coverUrl: song.cover_url ?? null,
		timestamp: new Date().toISOString(),
	};
}

export class DowntifyTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Downtify Trigger',
		name: 'downtifyTrigger',
		icon: { light: 'file:../../icons/downtify.svg', dark: 'file:../../icons/downtify.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Starts the workflow when Downtify finishes downloads or podcast episodes (polling)',
		defaults: {
			name: 'Downtify Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'downtifyApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				default: 'downloadFinished',
				options: [
					{
						name: 'Batch Finished',
						value: 'batchFinished',
						description: 'Every queued track of an album has finished, with downloaded and failed counts',
					},
					{ name: 'Download Failed', value: 'downloadFailed', description: 'A track download ends with an error' },
					{ name: 'Download Finished', value: 'downloadFinished', description: 'A track download finishes successfully' },
					{
						name: 'New Podcast Episode Downloaded',
						value: 'podcastEpisodeDownloaded',
						description: 'An episode of a subscribed show has been downloaded',
					},
				],
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { event: ['downloadFinished', 'downloadFailed', 'batchFinished'] } },
				options: [
					{ displayName: 'Album', name: 'album', type: 'string', default: '', description: 'Only albums whose title contains this text' },
					{ displayName: 'Artist', name: 'artist', type: 'string', default: '', description: 'Only tracks or albums whose artist contains this text' },
				],
			},
			{
				displayName: 'Include Already Present',
				name: 'includeAlreadyPresent',
				type: 'boolean',
				default: true,
				description:
					'Whether to fire also for tracks Downtify skipped because they were already in the library ("Download again if the file exists" off)',
				displayOptions: { show: { event: ['downloadFinished'] } },
			},
			{
				displayName: 'Show IDs',
				name: 'showIds',
				type: 'string',
				default: '',
				placeholder: '3,7',
				description: 'Only these subscribed shows (comma-separated IDs, empty = all)',
				displayOptions: { show: { event: ['podcastEpisodeDownloaded'] } },
			},
			{
				displayName: 'Max Shows Per Poll',
				name: 'maxShows',
				type: 'number',
				default: 50,
				typeOptions: { minValue: 1, maxValue: MAX_SHOWS },
				description: 'Maximum number of shows whose episodes are read at each poll (one request per show)',
				displayOptions: { show: { event: ['podcastEpisodeDownloaded'] } },
			},
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const event = this.getNodeParameter('event') as EventName;
		const manual = this.getMode() === 'manual';
		const state = this.getWorkflowStaticData('node') as TriggerState;
		if (state.event !== event) {
			for (const key of Object.keys(state)) delete (state as IDataObject)[key];
			state.event = event;
		}
		if (!manual && state.signInPause) {
			const raw = await this.getCredentials(CREDENTIAL_NAME);
			if (signInPaused(state.signInPause, raw, Date.now())) return null;
		}
		const firstRun = !state.initialized;
		if (firstRun && !manual) state.activatedAt = new Date().toISOString();
		let client: DowntifyClient | undefined;
		let snapshot: Snapshot;
		try {
			client = await DowntifyClient.create(this);
			switch (event) {
				case 'downloadFinished':
				case 'downloadFailed':
					snapshot = await pollJobs.call(this, client, state, event, manual, firstRun);
					break;
				case 'batchFinished':
					snapshot = await pollBatches.call(this, client, state, manual, firstRun);
					break;
				case 'podcastEpisodeDownloaded':
					snapshot = await pollEpisodes.call(this, client, state, manual, firstRun);
					break;
				default:
					throw new NodeOperationError(this.getNode(), `Unknown event "${String(event)}"`);
			}
		} catch (error) {
			const failure = client?.lastSignInFailure;
			if (!manual && failure) {
				const raw = await this.getCredentials(CREDENTIAL_NAME);
				const pause = pauseAfter(failure, raw, state.signInPause, Date.now());
				if (pause) {
					state.signInPause = { ...pause, reported: true };
					// Reported once: a later failure for the same status and credential stays silent
					if (pause.reported) return null;
				}
			}
			const e = error as { message?: string; description?: string };
			const redact = (s: string) => (client ? client.redact(s) : redactString(s));
			throw new NodeOperationError(this.getNode(), redact(e?.message ?? 'Polling failed'), {
				description: e?.description ? redact(e.description) : undefined,
			});
		}

		if (!manual) delete state.signInPause;
		if (manual) {
			// Test mode: a real sample built from current data; the stored state is not changed
			const items = snapshot.items.length ? snapshot.items : snapshot.sample ? [snapshot.sample] : [];
			if (!items.length) return null;
			return [items.map((json) => ({ json: client!.redactValue(json) }))];
		}
		if (firstRun) {
			state.initialized = true;
			return null;
		}
		if (!snapshot.items.length) return null;
		return [snapshot.items.map((json) => ({ json: client!.redactValue(json) }))];
	}
}

/** Download Finished / Download Failed: a job reaches `done` / `error` (dedupe by job ID + status). */
async function pollJobs(
	this: IPollFunctions,
	client: DowntifyClient,
	state: TriggerState,
	event: 'downloadFinished' | 'downloadFailed',
	manual: boolean,
	firstRun: boolean,
): Promise<Snapshot> {
	const filters = (this.getNodeParameter('filters', {}) ?? {}) as IDataObject;
	const includePresent = event === 'downloadFailed' || this.getNodeParameter('includeAlreadyPresent', true) !== false;
	const wanted = event === 'downloadFinished' ? 'done' : 'error';
	const rows = await getQueue(client);
	const seen = new Set(state.seen ?? []);
	const next: string[] = [];
	const items: IDataObject[] = [];
	let sample: IDataObject | undefined;
	// Only the most recent MAX_STATE_ENTRIES finished jobs are tracked
	const terminal = rows.filter((r) => rowJobId(r) !== undefined && isTerminal(r.status));
	const tracked = new Set(terminal.slice(-MAX_STATE_ENTRIES));
	for (const row of rows) {
		const id = rowJobId(row);
		if (id === undefined || !isTerminal(row.status) || !tracked.has(row)) continue;
		const key = `${stateKey(id)}|${String(row.status)}`;
		next.push(key);
		if (row.status !== wanted) continue;
		const song = (row.song ?? {}) as IDataObject;
		if (!matches(filters.artist, songArtist(song), songAlbumArtist(song))) continue;
		if (!matches(filters.album, songAlbum(song))) continue;
		if (!includePresent && isAlreadyPresent(row)) continue;
		const item = jobItem(event, row);
		sample = item;
		// A job seen queued or downloading again (a new download of the same track) has no
		// key in the previous state any more, so it fires again when it ends.
		if (!firstRun && !seen.has(key)) items.push(item);
	}
	if (!manual) state.seen = next;
	return { items: manual ? [] : items, sample };
}

interface AlbumGroup {
	key: string;
	album: string;
	artist: string;
	rows: IDataObject[];
}

function groupByAlbum(rows: IDataObject[]): Map<string, AlbumGroup> {
	const groups = new Map<string, AlbumGroup>();
	for (const row of rows) {
		const song = (row.song ?? {}) as IDataObject;
		const album = songAlbum(song).trim();
		if (!album || rowJobId(row) === undefined) continue;
		const artist = songAlbumArtist(song).trim();
		const key = stateKey(`${normalizeText(album)}|${normalizeText(artist)}`);
		let group = groups.get(key);
		if (!group) {
			group = { key, album, artist, rows: [] };
			groups.set(key, group);
		}
		group.rows.push(row);
	}
	return groups;
}

function batchItem(group: AlbumGroup): IDataObject {
	const done = group.rows.filter((r) => r.status === 'done');
	const failed = group.rows.filter((r) => r.status === 'error');
	const present = done.filter(isAlreadyPresent);
	return {
		event: 'batchFinished',
		album: group.album,
		artist: group.artist,
		total: group.rows.length,
		downloaded: done.length - present.length,
		alreadyPresent: present.length,
		failedCount: failed.length,
		failed: failed.map((r) => ({
			jobId: rowJobId(r),
			title: songTitle(r.song),
			artist: songArtist(r.song),
			message: r.message ?? '',
		})),
		files: done.filter((r) => !isAlreadyPresent(r)).map((r) => r.filename).filter(Boolean),
		jobIds: group.rows.map(rowJobId),
		timestamp: new Date().toISOString(),
	};
}

/** Batch Finished: every queued job of an album (album title + album artist) has ended. */
async function pollBatches(
	this: IPollFunctions,
	client: DowntifyClient,
	state: TriggerState,
	manual: boolean,
	firstRun: boolean,
): Promise<Snapshot> {
	const filters = (this.getNodeParameter('filters', {}) ?? {}) as IDataObject;
	const groups = groupByAlbum(await getQueue(client));
	const wasActive = new Set(state.activeAlbums ?? []);
	const active: string[] = [];
	const items: IDataObject[] = [];
	let sample: IDataObject | undefined;
	for (const group of groups.values()) {
		const finished = group.rows.every((r) => isTerminal(r.status));
		if (!finished) {
			active.push(group.key);
			continue;
		}
		if (!matches(filters.artist, group.artist) || !matches(filters.album, group.album)) continue;
		const item = batchItem(group);
		sample = item;
		if (!firstRun && wasActive.has(group.key)) items.push(item);
	}
	if (!manual) state.activeAlbums = active.slice(-MAX_STATE_ENTRIES);
	return { items: manual ? [] : items, sample };
}

/** New Podcast Episode Downloaded: an episode gets a file (dedupe by episode + download time). */
async function pollEpisodes(
	this: IPollFunctions,
	client: DowntifyClient,
	state: TriggerState,
	manual: boolean,
	firstRun: boolean,
): Promise<Snapshot> {
	let maxShows: number;
	try {
		maxShows = validateInteger(this.getNodeParameter('maxShows', 50), 'Max Shows Per Poll', 1, MAX_SHOWS);
	} catch (error) {
		throw new NodeOperationError(this.getNode(), (error as Error).message);
	}
	const showIds = csvList(this.getNodeParameter('showIds', ''));
	if (showIds.some((id) => !/^[1-9][0-9]{0,15}$/.test(id))) {
		throw new NodeOperationError(this.getNode(), 'Show IDs must be positive integers separated by commas');
	}
	const raw = await client.get<unknown>('/api/podcasts/shows');
	const shows = (Array.isArray(raw) ? raw : [])
		.filter((s): s is IDataObject => !!s && typeof s === 'object' && /^[1-9][0-9]{0,15}$/.test(String((s as IDataObject).id)))
		.filter((s) => !showIds.length || showIds.includes(String(s.id)))
		.slice(0, maxShows);
	const activatedAt = Date.parse(state.activatedAt ?? '') || 0;
	const seen = new Set(state.seen ?? []);
	const items: IDataObject[] = [];
	let sample: IDataObject | undefined;
	let sampleTime = -1;
	for (const show of shows) {
		const answer = (await client.get<IDataObject>(`/api/podcasts/shows/${Number(show.id)}/episodes`)) ?? {};
		const episodes = Array.isArray(answer.episodes) ? (answer.episodes as IDataObject[]) : [];
		for (const ep of episodes) {
			if (!ep || typeof ep !== 'object' || !ep.filename || !ep.downloaded_at) continue;
			const downloadedAt = String(ep.downloaded_at);
			const key = stateKey(`${String(show.id)}:${String(ep.id)}|${downloadedAt}`);
			const item: IDataObject = {
				event: 'podcastEpisodeDownloaded',
				showId: show.id,
				show: show.name ?? '',
				episodeId: ep.id,
				title: ep.title ?? '',
				filename: ep.filename,
				downloadedAt,
				publishedAt: ep.published_at ?? null,
				durationSeconds: ep.duration_seconds ?? null,
				seasonNumber: ep.season_number ?? null,
				episodeNumber: ep.episode_number ?? null,
			};
			const time = Date.parse(downloadedAt) || 0;
			if (time >= sampleTime) {
				sampleTime = time;
				sample = item;
			}
			if (seen.has(key)) continue;
			seen.add(key);
			// Only episodes downloaded after the trigger was activated (protects against a full state)
			if (!firstRun && !manual && time >= activatedAt) items.push(item);
		}
	}
	if (!manual) state.seen = [...seen].slice(-MAX_STATE_ENTRIES);
	return { items: manual ? [] : items, sample };
}
