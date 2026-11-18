import type { IDataObject } from 'n8n-workflow';

import type { DowntifyClient } from './transport';

/** Lower case, without accents, punctuation or repeated spaces ("Beyoncé & Jay-Z" -> "beyonce and jay z"). */
export function normalizeText(value: unknown): string {
	return String(value ?? '')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

/** The title without a trailing edition note: "(Deluxe Edition)", "[2011 Remaster]", "- Remastered". */
export function baseTitle(value: unknown): string {
	let text = String(value ?? '').trim();
	for (let i = 0; i < 4; i++) {
		const next = text
			.replace(/\s*[([][^()[\]]{1,80}[)\]]\s*$/, '')
			.replace(/\s+-\s+[^-]{1,60}(edition|remaster(ed)?|version|deluxe|expanded|anniversary)[^-]{0,40}$/i, '')
			.trim();
		if (next === text || next === '') break;
		text = next;
	}
	return normalizeText(text);
}

/** The whole credit and every artist named in it: "A, B feat. C" -> ["a b feat c", "a", "b", "c"]. */
export function artistCandidates(value: unknown): string[] {
	const raw = String(value ?? '').trim();
	if (raw === '') return [];
	const parts = raw
		.split(/\s*(?:,|;|\/|\bfeat\.?|\bft\.?|\bfeaturing\b|&|\band\b)\s*/i)
		.map(normalizeText)
		.filter(Boolean);
	return [...new Set([normalizeText(raw), ...parts])].filter(Boolean);
}

export interface AlbumMatchOptions {
	ignoreEdition?: boolean;
}

export function matchAlbums(albums: IDataObject[], artist: string, title: string, options: AlbumMatchOptions = {}): IDataObject[] {
	const ignoreEdition = options.ignoreEdition !== false;
	const wantedTitle = normalizeText(title);
	const wantedBase = baseTitle(title);
	const wantedArtists = artistCandidates(artist);
	if (wantedTitle === '') return [];
	return albums.filter((album) => {
		const t = normalizeText(album.title);
		const titleOk = t === wantedTitle || (ignoreEdition && wantedBase !== '' && baseTitle(album.title) === wantedBase);
		if (!titleOk) return false;
		if (!wantedArtists.length) return true;
		const have = artistCandidates(album.artist);
		return have.some((a) => wantedArtists.includes(a));
	});
}

export async function getLibraryAlbums(client: DowntifyClient): Promise<IDataObject[]> {
	const rows = await client.get<unknown>('/api/library/albums');
	if (!Array.isArray(rows)) throw client.error('Unexpected answer from GET /api/library/albums (not a list)');
	return rows.filter((r): r is IDataObject => !!r && typeof r === 'object' && !Array.isArray(r));
}

export async function findAlbum(
	client: DowntifyClient,
	artist: string,
	title: string,
	options: AlbumMatchOptions = {},
): Promise<{ found: boolean; album: IDataObject | null; matches: IDataObject[] }> {
	const matches = matchAlbums(await getLibraryAlbums(client), artist, title, options);
	return { found: matches.length > 0, album: matches[0] ?? null, matches };
}
