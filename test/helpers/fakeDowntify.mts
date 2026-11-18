/**
 * Minimal fake Downtify server for tests. It checks the device token (Authorization: Bearer)
 * like Downtify's AuthMiddleware and emulates the download queue of Downtify 3.8.1:
 * job ID = song_id (else url), a finished job is reset by a new request, an active one is
 * shared, a paused queue keeps jobs queued.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const TOKEN = 'dtfy_abcdefghjkmn_S3cr3tT0kenValue0123456789abcdefXYZ';

/** Account of the fake server for POST /api/auth/token. */
export const USERNAME = 'n8n';
export const PASSWORD = 'Pa55-w0rd!secret';

let issued = 0;

/** A new device token in Downtify's format (dtfy_<12 chars a-z2-9>_<secret>). */
function newDeviceToken(): string {
	issued++;
	const id = `n8ndevice${String(issued).padStart(3, '2').replace(/[01]/g, '2')}`.slice(-12).padStart(12, 'k');
	return `dtfy_${id}_IssuedSecret${String(issued).padStart(4, '0')}abcdefghijklmnopqrstuvwxyz`;
}

export interface RecordedRequest {
	method: string;
	path: string;
	query: URLSearchParams;
	headers: Record<string, string | string[] | undefined>;
	body: string;
	json: unknown;
}

export interface Reply {
	status?: number;
	json?: unknown;
	raw?: string;
	headers?: Record<string, string>;
	delayMs?: number;
}

export type Handler = (req: RecordedRequest, params: Record<string, string>) => Reply | Promise<Reply>;

/** What happens to a song at each download attempt. */
export type Outcome = 'done' | 'present' | 'error' | 'stuck';

export interface Job {
	song: Record<string, unknown>;
	status: 'queued' | 'downloading' | 'done' | 'error';
	progress: number;
	message: string;
	provider: string;
	filename: string | null;
	user_ids: number[];
}

interface Route {
	method: string;
	regex: RegExp;
	names: string[];
	handler: Handler;
}

export function song(id: string, title: string, artist = 'Test Artist', album = 'Test Album', extra: Record<string, unknown> = {}) {
	return {
		song_id: id,
		name: title,
		artists: [artist],
		artist,
		album_name: album,
		url: `https://open.spotify.com/track/${id}`,
		cover_url: `https://img.example/${id}.jpg`,
		source: 'spotify',
		...extra,
	};
}

export class FakeDowntify {
	readonly requests: RecordedRequest[] = [];

	readonly queue = new Map<string, Job>();

	/** Outcomes per song ID, one per download attempt (default: done). */
	readonly plan = new Map<string, Outcome[]>();

	/** Resolve answers per URL. */
	readonly links = new Map<string, Record<string, unknown>>();

	paused = false;

	authDisabled = false;

	/** Device tokens Downtify accepts (the fixed TOKEN plus the ones issued by sign-in). */
	readonly tokens = new Set<string>([TOKEN]);

	/** Tokens issued by POST /api/auth/token, in order. */
	readonly issuedTokens: string[] = [];

	/** POST /api/auth/token answers 409 (DOWNTIFY_DISABLE_AUTH / DISABLE_LOCAL_LOGIN). */
	signInDisabled = false;

	/** When false, GET /api/queue does not advance the jobs. */
	advance = true;

	albums: Array<Record<string, unknown>> = [];

	shows: Array<Record<string, unknown>> = [];

	episodes = new Map<number, Array<Record<string, unknown>>>();

	private routes: Route[] = [];

	private server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			void this.handle(req, res, Buffer.concat(chunks));
		});
	});

	constructor() {
		this.installDefaults();
	}

	async start(): Promise<this> {
		await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
		return this;
	}

	async stop(): Promise<void> {
		this.server.closeAllConnections();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	get url(): string {
		return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}

	reset(): void {
		this.requests.length = 0;
		this.queue.clear();
		this.plan.clear();
		this.links.clear();
		this.paused = false;
		this.authDisabled = false;
		this.tokens.clear();
		this.tokens.add(TOKEN);
		this.issuedTokens.length = 0;
		this.signInDisabled = false;
		this.advance = true;
		this.albums = [];
		this.shows = [];
		this.episodes.clear();
		this.routes = [];
		this.installDefaults();
	}

	on(method: string, pattern: string, handler: Handler): this {
		const names: string[] = [];
		const regex = new RegExp(
			`^${pattern.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{([^}]+)\\?\}/g, (_m, n: string) => {
				names.push(n);
				return '([^/]+)';
			})}$`,
		);
		this.routes.unshift({ method, regex, names, handler });
		return this;
	}

	requestsTo(method: string, path: string): RecordedRequest[] {
		return this.requests.filter((r) => r.method === method && r.path === path);
	}

	/** Adds a job to the queue as another request would. */
	addJob(s: Record<string, unknown>, status: Job['status'], extra: Partial<Job> = {}): void {
		this.queue.set(String(s.song_id ?? s.url), {
			song: s,
			status,
			progress: status === 'done' ? 100 : 0,
			message: status === 'done' ? 'Done' : '',
			provider: '',
			filename: status === 'done' ? `${String(s.artist)} - ${String(s.name)}.mp3` : null,
			user_ids: [2],
			...extra,
		});
	}

	/** Registers the songs like Downtify's _register_job; returns the job IDs. */
	register(songs: Array<Record<string, unknown>>): string[] {
		const ids: string[] = [];
		for (const s of songs) {
			const id = String(s.song_id || s.url);
			const job = this.queue.get(id);
			if (!job) {
				this.queue.set(id, { song: s, status: 'queued', progress: 0, message: '', provider: '', filename: null, user_ids: [2] });
			} else if (job.status !== 'queued' && job.status !== 'downloading') {
				Object.assign(job, { status: 'queued', progress: 0, message: '', provider: '', filename: null });
			}
			ids.push(id);
		}
		return ids;
	}

	/** One step of the download workers: queued -> downloading -> outcome. */
	tick(): void {
		for (const [id, job] of this.queue) {
			if (job.status === 'downloading') {
				const outcome = this.plan.get(id)?.shift() ?? 'done';
				if (outcome === 'stuck') {
					this.plan.set(id, ['stuck']);
					continue;
				}
				const file = `${String(job.song.artist)} - ${String(job.song.name)}.mp3`;
				if (outcome === 'done') Object.assign(job, { status: 'done', progress: 100, message: 'Done', filename: file, provider: 'youtube-music' });
				if (outcome === 'present') Object.assign(job, { status: 'done', progress: 100, message: 'Already in library', filename: file });
				if (outcome === 'error') Object.assign(job, { status: 'error', progress: 0, message: 'Error: no audio match found' });
			} else if (job.status === 'queued' && !this.paused) {
				job.status = 'downloading';
			}
		}
	}

	/** Revokes a device token (Settings > Apps > Revoke). */
	revoke(token: string): void {
		this.tokens.delete(token);
	}

	private installDefaults(): void {
		this.on('POST', '/api/auth/token', (req) => {
			if (this.signInDisabled || this.authDisabled) {
				return { status: 409, json: { detail: 'Sign-in is turned off (DOWNTIFY_DISABLE_AUTH)' } };
			}
			const body = (req.json ?? {}) as Record<string, unknown>;
			if (body.username !== USERNAME || body.password !== PASSWORD) {
				return { status: 401, json: { detail: 'Wrong username or password' } };
			}
			const token = newDeviceToken();
			this.tokens.add(token);
			this.issuedTokens.push(token);
			return {
				json: {
					token,
					device: { id: token.split('_')[1], name: String(body.device_name ?? ''), platform: String(body.platform ?? '') },
					server: { name: 'Downtify' },
					user: { id: 2, username: USERNAME, role: 'user' },
				},
			};
		});
		this.on('GET', '/api/health', () => ({ json: { status: 'ok', version: '3.8.1' } }));
		this.on('GET', '/api/version', () => ({ json: '3.8.1' }));
		this.on('GET', '/api/me', () => ({
			json: { user: { id: 2, username: 'n8n', role: 'user' }, preferences: {}, playlist_sharing: true },
		}));
		this.on('GET', '/api/url/resolve', (req) => {
			const url = req.query.get('url') ?? '';
			const answer = this.links.get(url);
			if (!answer) return { status: 400, json: { detail: 'Invalid URL' } };
			return { json: answer };
		});
		this.on('POST', '/api/download/batch', (req) => {
			const body = (req.json ?? {}) as { songs?: Array<Record<string, unknown>> };
			if (!Array.isArray(body.songs) || !body.songs.length) return { status: 400, json: { detail: 'songs must be a non-empty list' } };
			const ids = this.register(body.songs.filter((s) => s && typeof s === 'object'));
			return { json: { job_ids: ids, count: ids.length } };
		});
		this.on('GET', '/api/queue', () => {
			if (this.advance) this.tick();
			let position = 0;
			return {
				json: [...this.queue.values()].map((job) => ({
					...job,
					position: job.status === 'queued' || job.status === 'downloading' ? ++position : null,
				})),
			};
		});
		this.on('GET', '/api/queue/state', () => ({
			json: { paused: this.paused, state: this.paused ? 'paused' : 'running', active: 0, can_control: false, global_pause_supported: true, monitors_paused: this.paused },
		}));
		this.on('GET', '/api/library/albums', () => ({ json: this.albums }));
		this.on('GET', '/api/library/artists', () => ({ json: [{ name: 'Daft Punk', track_count: 14, album_count: 1 }] }));
		this.on('GET', '/api/library/summary', () => ({ json: { tracks: 14, albums: 1, artists: 1, recent: [] } }));
		this.on('GET', '/tracks', (req) => {
			const rows = [
				{ file: 'Daft Punk/Discovery/01 One More Time.mp3', title: 'One More Time', artist: 'Daft Punk', album: 'Discovery' },
				{ file: 'Air/Moon Safari/01 La femme d argent.mp3', title: "La femme d'argent", artist: 'Air', album: 'Moon Safari' },
			];
			const artist = req.query.get('artist');
			const limit = Number(req.query.get('limit') ?? 0);
			const out = rows.filter((r) => !artist || r.artist === artist);
			return { json: limit ? out.slice(0, limit) : out };
		});
		this.on('GET', '/api/v1/tracks/{id}', (_req, p) =>
			p.id === 'trk1' ? { json: { id: 'trk1', title: 'One More Time', artist: 'Daft Punk' } } : { status: 404, json: { detail: 'Track not found' } },
		);
		this.on('GET', '/api/v1/playlists', () => ({ json: [{ name: 'Road trip', count: 2, track_ids: ['trk1', 'trk2'] }] }));
		this.on('GET', '/api/monitor/playlists', () => ({ json: [{ id: 1, name: 'Discover Weekly', source: 'spotify', enabled: true }] }));
		this.on('GET', '/api/monitor/stats', () => ({ status: 403, json: { detail: 'This needs a signed-in browser' } }));
		this.on('GET', '/api/songs/search', (req) => ({ json: [song('s1', `Result for ${req.query.get('query') ?? ''}`)] }));
		this.on('GET', '/api/finder/search', (req) => ({
			json: { songs: [song('s1', 'Song')], albums: [{ album_id: '302127', title: 'Discovery' }], artists: [{ artist_id: '27', name: 'Daft Punk', limit: req.query.get('limit') }] },
		}));
		this.on('GET', '/api/finder/artist/albums', (req) =>
			req.query.get('artist_id') === '27'
				? {
						json: [
							{ album_id: '1', title: 'Random Access Memories', release_type: 'Album' },
							{ album_id: '2', title: 'Get Lucky', release_type: 'Single' },
							{ album_id: '3', title: 'Alive EP', release_type: 'EP' },
						],
					}
				: { status: 502, json: { detail: 'Deezer artist not found' } },
		);
		this.on('GET', '/api/podcasts/shows', () => ({ json: this.shows }));
		this.on('GET', '/api/podcasts/shows/{id}', (_req, p) => {
			const show = this.shows.find((s) => String(s.id) === p.id);
			return show ? { json: show } : { status: 404, json: { detail: 'Show not found' } };
		});
		this.on('GET', '/api/podcasts/shows/{id}/episodes', (_req, p) => {
			const show = this.shows.find((s) => String(s.id) === p.id);
			if (!show) return { status: 404, json: { detail: 'Show not found' } };
			return { json: { show, episodes: this.episodes.get(Number(p.id)) ?? [] } };
		});
		this.on('GET', '/api/podcasts/search', (req) => ({ json: { results: [{ name: `Podcast ${req.query.get('q') ?? ''}`, feed_url: 'https://feeds.example/p.xml' }] } }));
		this.on('POST', '/api/podcasts/resolve', (req) => ({ json: { name: 'Preview', feed_url: (req.json as { url?: string })?.url, already_subscribed: false } }));
		this.on('POST', '/api/podcasts/episodes/{id}/download', (_req, p) => {
			for (const list of this.episodes.values()) {
				const ep = list.find((e) => String(e.id) === p.id);
				if (ep) {
					Object.assign(ep, { filename: `Podcasts/Show/${String(ep.title)}.mp3`, downloaded_at: new Date().toISOString() });
					return { json: ep };
				}
			}
			return { status: 404, json: { detail: 'Episode not found' } };
		});
	}

	private authorized(req: RecordedRequest): { status: number; detail: string } | null {
		const auth = req.headers.authorization;
		if (typeof auth === 'string' && auth.slice(0, 7).toLowerCase() === 'bearer ') {
			return this.tokens.has(auth.slice(7).trim()) ? null : { status: 401, detail: 'Invalid or revoked token' };
		}
		if (this.authDisabled) return null;
		return { status: 401, detail: 'Sign in required' };
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse, raw: Buffer) {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const body = raw.toString('utf8');
		let json: unknown;
		try {
			json = body ? JSON.parse(body) : undefined;
		} catch {
			json = undefined;
		}
		const recorded: RecordedRequest = { method: String(req.method), path: url.pathname, query: url.searchParams, headers: req.headers, body, json };
		this.requests.push(recorded);

		const send = (reply: Reply) => {
			const status = reply.status ?? 200;
			const payload = reply.raw !== undefined ? reply.raw : JSON.stringify(reply.json ?? null);
			res.writeHead(status, { 'Content-Type': 'application/json', ...(reply.headers ?? {}) });
			res.end(payload);
		};

		const isPublic = ['/api/health', '/api/version', '/api/auth/token'].includes(url.pathname);
		if (!isPublic) {
			const denied = this.authorized(recorded);
			if (denied) return send({ status: denied.status, json: { detail: denied.detail }, headers: { 'WWW-Authenticate': 'Bearer' } });
		}
		for (const route of this.routes) {
			if (route.method !== recorded.method) continue;
			const m = route.regex.exec(url.pathname);
			if (!m) continue;
			const params: Record<string, string> = {};
			route.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
			const reply = await route.handler(recorded, params);
			if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
			return send(reply);
		}
		return send({ status: 404, json: { detail: 'Not Found' } });
	}
}

/** A second server that must never receive anything (redirect target). */
export class Trap {
	readonly hits: Array<{ url: string; headers: Record<string, unknown> }> = [];

	private server = http.createServer((req, res) => {
		this.hits.push({ url: String(req.url), headers: req.headers });
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end('{"stolen":true}');
	});

	async start(): Promise<this> {
		await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
		return this;
	}

	get url(): string {
		return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}

	async stop(): Promise<void> {
		this.server.closeAllConnections();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}
