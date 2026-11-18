import type { INodeProperties } from 'n8n-workflow';

import { returnAllLimit, splitIntoItems } from '../../shared/descriptions';

const R = 'monitor';

export const monitorDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		default: 'getMany',
		options: [
			{
				name: 'Get Many',
				value: 'getMany',
				action: 'Get watched playlists',
				description: 'Playlists and artists watched by the Playlist Monitor (read-only)',
			},
		],
	},
	{
		displayName:
			'Monitor statistics and the tracks added by a watch are available only to a signed-in browser: Downtify answers 403 to a device token.',
		name: 'monitorNotice',
		type: 'notice',
		default: '',
		displayOptions: { show: { resource: [R] } },
	},
	...returnAllLimit(R, ['getMany']),
	splitIntoItems(R, ['getMany']),
];
