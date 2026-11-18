import type { INodeProperties } from 'n8n-workflow';

const R = 'server';

export const serverDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		default: 'health',
		options: [
			{ name: 'Get Me', value: 'getMe', action: 'Get the token user', description: 'The user the device token belongs to, with preferences' },
			{ name: 'Health', value: 'health', action: 'Check server health', description: 'Whether the Downtify server is up (and its database reachable)' },
			{ name: 'Version', value: 'version', action: 'Get the server version', description: 'Downtify version' },
		],
	},
];
