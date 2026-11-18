import type { INodeProperties } from 'n8n-workflow';

import { pollIntervalOption, timeoutOption } from '../../shared/descriptions';

const R = 'download';
const show = { resource: [R], operation: ['downloadUrl'] };

export const downloadDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		default: 'downloadUrl',
		options: [
			{
				name: 'Download URL',
				value: 'downloadUrl',
				action: 'Download a track album or playlist link',
				description:
					'DOWNLOADS FILES: resolves a Spotify, Deezer, YouTube Music or SoundCloud link (track, album or playlist) and queues every track for download into the Downtify library on the server disk. Use only when the user asks to download music. Returns a summary of downloaded, already present and failed tracks.',
			},
		],
	},
	{
		displayName: 'URL',
		name: 'url',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'https://open.spotify.com/album/…',
		description: 'Link to a track, album or playlist on Spotify, Deezer, YouTube Music or SoundCloud. Artist links are not supported.',
		displayOptions: { show },
	},
	{
		displayName: 'Wait For Completion',
		name: 'waitForCompletion',
		type: 'boolean',
		default: true,
		description:
			'Whether to wait until every queued track has finished downloading. If disabled, the node returns as soon as the tracks are queued.',
		displayOptions: { show },
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show },
		options: [
			{
				displayName: 'Fail On Error',
				name: 'failOnError',
				type: 'boolean',
				default: true,
				description:
					'Whether the node fails when tracks fail, the queue is paused while waiting or the timeout is reached. If disabled, the summary is returned with the failed and pending tracks.',
			},
			{
				displayName: 'Generate M3U',
				name: 'generateM3u',
				type: 'boolean',
				default: true,
				description: 'Whether Downtify writes an M3U file for the playlist (playlists only)',
			},
			{ ...pollIntervalOption, description: 'Seconds between queue checks while waiting (minimum 1)' },
			{
				displayName: 'Retry Failed Tracks',
				name: 'retryFailedTracks',
				type: 'number',
				default: 1,
				typeOptions: { minValue: 0, maxValue: 5 },
				description:
					'How many times failed tracks are queued again and waited for (0 = no retry). Only used with Wait For Completion.',
			},
			{
				displayName: 'Skip If In Library',
				name: 'skipIfInLibrary',
				type: 'boolean',
				default: false,
				description:
					'Whether to queue nothing when the album (artist and title) is already in the library (albums only). The summary then has skipped: true.',
			},
			{ ...timeoutOption, description: 'Maximum total time to wait, retries included (maximum 86400 = 24 h). Downloads keep running in Downtify after a timeout.' },
		],
	},
];
