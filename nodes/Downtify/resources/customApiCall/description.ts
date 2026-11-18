import type { INodeProperties } from 'n8n-workflow';

import { splitIntoItems } from '../../shared/descriptions';

const R = 'customApiCall';
const show = { resource: [R], operation: ['call'] };

export const customApiCallDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		default: 'call',
		options: [
			{
				name: 'Call',
				value: 'call',
				action: 'Make a custom API call',
				description:
					'Sends a request to a Downtify endpoint that a paired device may use. POST requests to download endpoints DOWNLOAD FILES to the server. Prefer the dedicated operations.',
			},
		],
	},
	{
		displayName:
			'Only endpoints a paired device may use are allowed (for example GET /api/queue). Admin and browser-only endpoints, absolute URLs and paths outside the server are refused before sending.',
		name: 'customNotice',
		type: 'notice',
		default: '',
		displayOptions: { show },
	},
	{
		displayName: 'Method',
		name: 'method',
		type: 'options',
		default: 'GET',
		options: [
			{ name: 'DELETE', value: 'DELETE' },
			{ name: 'GET', value: 'GET' },
			{ name: 'PATCH', value: 'PATCH' },
			{ name: 'POST', value: 'POST' },
			{ name: 'PUT', value: 'PUT' },
		],
		displayOptions: { show },
	},
	{
		displayName: 'Path',
		name: 'path',
		type: 'string',
		default: '',
		required: true,
		placeholder: '/api/queue/state',
		description: 'Path relative to the Base URL',
		displayOptions: { show },
	},
	{
		displayName: 'Query Parameters',
		name: 'queryParameters',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Query Parameter',
		default: {},
		displayOptions: { show },
		options: [
			{
				name: 'parameter',
				displayName: 'Parameter',
				values: [
					{ displayName: 'Name', name: 'name', type: 'string', default: '' },
					{ displayName: 'Value', name: 'value', type: 'string', default: '' },
				],
			},
		],
	},
	{
		displayName: 'Body (JSON)',
		name: 'body',
		type: 'json',
		default: '{}',
		description: 'JSON body for POST, PUT, PATCH and DELETE',
		displayOptions: { show: { ...show, method: ['POST', 'PUT', 'PATCH', 'DELETE'] } },
	},
	splitIntoItems(R, ['call']),
];
