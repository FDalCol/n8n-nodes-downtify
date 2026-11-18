import type { INodeProperties } from 'n8n-workflow';

import { returnAllLimit, splitIntoItems } from '../../shared/descriptions';

const R = 'queue';

export const queueDescription: INodeProperties[] = [
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
				action: 'Get download jobs',
				description:
					'List the download jobs of the token user (every user for an admin account), with job ID, status, progress, message and file',
			},
			{
				name: 'Get State',
				value: 'getState',
				action: 'Get the queue state',
				description: 'Whether the download queue is running or paused, and how many downloads are active',
			},
		],
	},
	{
		displayName: 'Statuses',
		name: 'statuses',
		type: 'multiOptions',
		default: [],
		options: [
			{ name: 'Done', value: 'done' },
			{ name: 'Downloading', value: 'downloading' },
			{ name: 'Error', value: 'error' },
			{ name: 'Queued', value: 'queued' },
		],
		description: 'Only return jobs with these statuses (empty = all)',
		displayOptions: { show: { resource: [R], operation: ['getMany'] } },
	},
	...returnAllLimit(R, ['getMany']),
	splitIntoItems(R, ['getMany']),
];
