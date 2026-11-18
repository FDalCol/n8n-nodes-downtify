import type { INodeProperties } from 'n8n-workflow';

import { returnAllLimit, splitIntoItems, timeoutOption } from '../../shared/descriptions';

const R = 'podcast';
const LISTS = ['getShows', 'getEpisodes', 'search'];

export const podcastDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		default: 'getShows',
		options: [
			{
				name: 'Download Episode',
				value: 'downloadEpisode',
				action: 'Download a podcast episode',
				description:
					'DOWNLOADS A FILE: downloads one episode of a subscribed show to the Downtify server disk and waits until it is saved. Use only when the user asks to download an episode.',
			},
			{ name: 'Get Episodes', value: 'getEpisodes', action: 'Get the episodes of a show', description: 'Episodes of a subscribed show, with download state' },
			{ name: 'Get Show', value: 'getShow', action: 'Get a show', description: 'One subscribed show' },
			{ name: 'Get Shows', value: 'getShows', action: 'Get subscribed shows', description: 'Podcast shows the token user is subscribed to' },
			{
				name: 'Resolve',
				value: 'resolve',
				action: 'Preview a podcast link',
				description: 'Preview a podcast from an RSS feed or a Spotify show/episode link. Does not subscribe.',
			},
			{ name: 'Search', value: 'search', action: 'Search podcasts', description: 'Search the podcast directory (iTunes). Does not subscribe.' },
		],
	},
	{
		displayName: 'Show ID',
		name: 'showId',
		type: 'string',
		default: '',
		required: true,
		placeholder: '12',
		displayOptions: { show: { resource: [R], operation: ['getShow', 'getEpisodes'] } },
	},
	{
		displayName: 'Episode ID',
		name: 'episodeId',
		type: 'string',
		default: '',
		required: true,
		placeholder: '345',
		displayOptions: { show: { resource: [R], operation: ['downloadEpisode'] } },
	},
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		default: '',
		required: true,
		displayOptions: { show: { resource: [R], operation: ['search'] } },
	},
	{
		displayName: 'URL',
		name: 'url',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'https://example.com/feed.xml',
		description: 'RSS feed URL or Spotify show/episode link',
		displayOptions: { show: { resource: [R], operation: ['resolve'] } },
	},
	{
		displayName: 'Filters',
		name: 'episodeFilters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: [R], operation: ['getEpisodes'] } },
		options: [
			{ displayName: 'Include Dismissed', name: 'includeDismissed', type: 'boolean', default: false, description: 'Whether to include episodes that were dismissed' },
			{
				displayName: 'Download State',
				name: 'downloadState',
				type: 'options',
				default: 'any',
				options: [
					{ name: 'Any', value: 'any' },
					{ name: 'Downloaded', value: 'downloaded' },
					{ name: 'Not Downloaded', value: 'notDownloaded' },
				],
			},
		],
	},
	{
		...timeoutOption,
		displayName: 'Timeout (Seconds)',
		description:
			'Maximum time to wait for the download (maximum 86400 = 24 h). Downtify answers only when the episode is saved.',
		displayOptions: { show: { resource: [R], operation: ['downloadEpisode'] } },
	},
	...returnAllLimit(R, LISTS),
	splitIntoItems(R, LISTS),
];
