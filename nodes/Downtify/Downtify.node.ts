import {
	NodeConnectionTypes,
	NodeOperationError,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import { customApiCallDescription } from './resources/customApiCall/description';
import { customApiCallHandlers } from './resources/customApiCall/execute';
import { downloadDescription } from './resources/download/description';
import { downloadHandlers } from './resources/download/execute';
import { libraryDescription } from './resources/library/description';
import { libraryHandlers } from './resources/library/execute';
import { monitorDescription } from './resources/monitor/description';
import { monitorHandlers } from './resources/monitor/execute';
import { podcastDescription } from './resources/podcast/description';
import { podcastHandlers } from './resources/podcast/execute';
import { queueDescription } from './resources/queue/description';
import { queueHandlers } from './resources/queue/execute';
import { searchDescription } from './resources/search/description';
import { searchHandlers } from './resources/search/execute';
import { serverDescription } from './resources/server/description';
import { serverHandlers } from './resources/server/execute';
import { finalize, OperationContext, safeError, type ResourceHandlers } from './shared/engine';
import { DowntifyClient } from './shared/transport';

const HANDLERS: Record<string, ResourceHandlers> = {
	download: downloadHandlers,
	queue: queueHandlers,
	search: searchHandlers,
	library: libraryHandlers,
	monitor: monitorHandlers,
	podcast: podcastHandlers,
	server: serverHandlers,
	customApiCall: customApiCallHandlers,
};

export class Downtify implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Downtify',
		name: 'downtify',
		icon: { light: 'file:../../icons/downtify.svg', dark: 'file:../../icons/downtify.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Download music links with Downtify and read its queue, library, playlist monitor and podcasts',
		defaults: {
			name: 'Downtify',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'downtifyApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Custom API Call', value: 'customApiCall', description: 'Any endpoint a paired device may use' },
					{ name: 'Download', value: 'download', description: 'Download track, album and playlist links (writes files on the server)' },
					{ name: 'Library', value: 'library', description: 'Albums, artists, tracks and playlists in the library' },
					{ name: 'Playlist Monitor', value: 'monitor', description: 'Watched playlists (read-only)' },
					{ name: 'Podcast', value: 'podcast', description: 'Subscribed shows and episodes' },
					{ name: 'Queue', value: 'queue', description: 'Download jobs and queue state' },
					{ name: 'Resolve & Search', value: 'search', description: 'Resolve links and search songs, albums and artists' },
					{ name: 'Server', value: 'server', description: 'Health, version and the token user' },
				],
				default: 'download',
			},
			...downloadDescription,
			...queueDescription,
			...searchDescription,
			...libraryDescription,
			...monitorDescription,
			...podcastDescription,
			...serverDescription,
			...customApiCallDescription,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];
		let client: DowntifyClient | undefined;

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				client = client ?? (await DowntifyClient.create(this));
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const handler = Object.prototype.hasOwnProperty.call(HANDLERS, resource) ? HANDLERS[resource][operation] : undefined;
				if (!handler || !Object.prototype.hasOwnProperty.call(HANDLERS[resource], operation)) {
					throw new NodeOperationError(this.getNode(), `Unsupported operation "${operation}" for resource "${resource}"`, { itemIndex });
				}
				const ctx = new OperationContext(this, client, itemIndex);
				output.push(...finalize(ctx, await handler(ctx)));
			} catch (error) {
				const { message, description } = safeError(client, error);
				if (this.continueOnFail()) {
					output.push({
						json: description ? { error: message, details: description } : { error: message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), message, { itemIndex, description });
			}
		}
		return [output];
	}
}
