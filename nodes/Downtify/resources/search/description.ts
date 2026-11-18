import type { INodeProperties } from 'n8n-workflow';

import { splitIntoItems } from '../../shared/descriptions';

const R = 'search';

export const searchDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		default: 'resolveUrl',
		options: [
			{
				name: 'Get Artist Albums',
				value: 'getArtistAlbums',
				action: 'Get the discography of an artist',
				description: 'Every release of a Deezer artist (album, EP, single, compilation), most recent first. Downloads nothing.',
			},
			{
				name: 'Resolve URL',
				value: 'resolveUrl',
				action: 'Resolve a link',
				description:
					'What a Spotify, Deezer, YouTube Music or SoundCloud link points at (track, album, playlist or artist) with its tracks. Downloads nothing.',
			},
			{
				name: 'Search',
				value: 'finderSearch',
				action: 'Search songs albums and artists',
				description: 'Finder search on Deezer: songs, albums and artists. Downloads nothing.',
			},
			{
				name: 'Search Songs',
				value: 'searchSongs',
				action: 'Search songs',
				description: 'Song search with the providers configured in Downtify (up to 20 results). Downloads nothing.',
			},
		],
	},
	{
		displayName: 'URL',
		name: 'url',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'https://www.deezer.com/album/…',
		description: 'Spotify, Deezer, YouTube Music or SoundCloud link',
		displayOptions: { show: { resource: [R], operation: ['resolveUrl'] } },
	},
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'Artist - Title',
		displayOptions: { show: { resource: [R], operation: ['searchSongs', 'finderSearch'] } },
	},
	{
		displayName: 'Return',
		name: 'resultType',
		type: 'options',
		default: 'all',
		options: [
			{ name: 'All (One Item)', value: 'all', description: 'One item with songs, albums and artists' },
			{ name: 'Albums', value: 'albums' },
			{ name: 'Artists', value: 'artists' },
			{ name: 'Songs', value: 'songs' },
		],
		displayOptions: { show: { resource: [R], operation: ['finderSearch'] } },
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1, maxValue: 50 },
		description: 'Max number of results to return',
		displayOptions: { show: { resource: [R], operation: ['finderSearch'] } },
	},
	{
		displayName: 'Artist ID',
		name: 'artistId',
		type: 'string',
		default: '',
		required: true,
		placeholder: '27',
		description: 'Deezer artist ID (from Search > Artists, or the number in a deezer.com/artist/… link)',
		displayOptions: { show: { resource: [R], operation: ['getArtistAlbums'] } },
	},
	{
		displayName: 'Release Types',
		name: 'releaseTypes',
		type: 'multiOptions',
		default: [],
		options: [
			{ name: 'Album', value: 'Album' },
			{ name: 'Compilation', value: 'Compilation' },
			{ name: 'EP', value: 'EP' },
			{ name: 'Single', value: 'Single' },
		],
		description: 'Only return these release types (empty = all)',
		displayOptions: { show: { resource: [R], operation: ['getArtistAlbums'] } },
	},
	splitIntoItems(R, ['searchSongs', 'finderSearch', 'getArtistAlbums']),
];
