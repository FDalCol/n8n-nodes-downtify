import type { INodeProperties } from 'n8n-workflow';

import { MAX_LIST_ENTRIES } from './security';

export const README_URL = 'https://github.com/FDalCol/n8n-nodes-downtify#readme';

export function splitIntoItems(resource: string, operations: string[]): INodeProperties {
	return {
		displayName: 'Split Into Items',
		name: 'splitIntoItems',
		type: 'boolean',
		default: true,
		description: 'Whether to output one item per list entry. If disabled, one item with a "data" array is returned.',
		displayOptions: { show: { resource: [resource], operation: operations } },
	};
}

export function returnAllLimit(resource: string, operations: string[]): INodeProperties[] {
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
			displayOptions: { show: { resource: [resource], operation: operations } },
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			default: 50,
			typeOptions: { minValue: 1, maxValue: MAX_LIST_ENTRIES },
			description: 'Max number of results to return',
			displayOptions: { show: { resource: [resource], operation: operations, returnAll: [false] } },
		},
	];
}

export const pollIntervalOption: INodeProperties = {
	displayName: 'Poll Interval (Seconds)',
	name: 'pollInterval',
	type: 'number',
	default: 5,
	typeOptions: { minValue: 1, maxValue: 3600 },
	description: 'Seconds between queue checks (minimum 1)',
};

export const timeoutOption: INodeProperties = {
	displayName: 'Timeout (Seconds)',
	name: 'timeout',
	type: 'number',
	default: 3600,
	typeOptions: { minValue: 1, maxValue: 86400 },
	description: 'Maximum time to wait (maximum 86400 = 24 h). Downloads keep running in Downtify after a timeout.',
};
