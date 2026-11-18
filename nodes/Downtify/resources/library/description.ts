import type { INodeProperties } from 'n8n-workflow';

import { returnAllLimit, splitIntoItems } from '../../shared/descriptions';

const R = 'library';
const LISTS = ['getAlbums', 'getArtists', 'getTracks', 'getPlaylists'];

export const libraryDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		default: 'getAlbums',
		options: [
			{
				name: 'Find Album',
				value: 'findAlbum',
				action: 'Find an album in the library',
				description: 'Whether an album (artist and title) is already in the Downtify library',
			},
			{ name: 'Get Albums', value: 'getAlbums', action: 'Get library albums', description: 'Albums in the library, most recently added first' },
			{ name: 'Get Artists', value: 'getArtists', action: 'Get library artists', description: 'Artists in the library' },
			{ name: 'Get Playlists', value: 'getPlaylists', action: 'Get library playlists', description: 'Playlists visible to the token user, with track IDs' },
			{ name: 'Get Summary', value: 'getSummary', action: 'Get the library summary', description: 'Library counts and recently added albums' },
			{ name: 'Get Track', value: 'getTrack', action: 'Get a track', description: 'Details of one library track by its ID' },
			{ name: 'Get Tracks', value: 'getTracks', action: 'Get library tracks', description: 'Library tracks with tags, optionally filtered by artist, album, playlist or text' },
		],
	},
	{
		displayName: 'Artist',
		name: 'artist',
		type: 'string',
		default: '',
		placeholder: 'Daft Punk',
		description: 'Album artist. Empty = match by title only.',
		displayOptions: { show: { resource: [R], operation: ['findAlbum'] } },
	},
	{
		displayName: 'Album Title',
		name: 'title',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'Discovery',
		displayOptions: { show: { resource: [R], operation: ['findAlbum'] } },
	},
	{
		displayName: 'Ignore Edition Notes',
		name: 'ignoreEdition',
		type: 'boolean',
		default: true,
		description: 'Whether "Discovery" also matches "Discovery (Deluxe Edition)" or "Discovery - 2021 Remaster"',
		displayOptions: { show: { resource: [R], operation: ['findAlbum'] } },
	},
	{
		displayName: 'Track ID',
		name: 'trackId',
		type: 'string',
		default: '',
		required: true,
		description: 'Library track ID (from Get Playlists track_ids or the mobile library listing)',
		displayOptions: { show: { resource: [R], operation: ['getTrack'] } },
	},
	{
		displayName: 'Filters',
		name: 'trackFilters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: [R], operation: ['getTracks'] } },
		options: [
			{ displayName: 'Album', name: 'album', type: 'string', default: '', description: 'Tracks of this album' },
			{ displayName: 'Artist', name: 'artist', type: 'string', default: '', description: 'Tracks this artist is credited on' },
			{ displayName: 'Playlist', name: 'playlist', type: 'string', default: '', description: 'Tracks of this downloaded playlist (name)' },
			{ displayName: 'Text', name: 'q', type: 'string', default: '', description: 'Free text search in title, artist and album' },
		],
	},
	...returnAllLimit(R, LISTS),
	splitIntoItems(R, LISTS),
];
