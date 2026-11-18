import { applyLimit, data, list, type ResourceHandlers } from '../../shared/engine';
import { describeRow, getQueue, getQueueState } from '../../shared/queue';

const STATUSES = ['queued', 'downloading', 'done', 'error'];

export const queueHandlers: ResourceHandlers = {
	getMany: async (ctx) => {
		const raw = ctx.param<unknown>('statuses', []);
		const statuses = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
			.map((s) => String(s).trim())
			.filter(Boolean);
		const unknown = statuses.filter((s) => !STATUSES.includes(s));
		if (unknown.length) throw ctx.client.error(`Unknown status "${unknown[0].slice(0, 32)}" (use ${STATUSES.join(', ')})`);
		const limit = ctx.limit();
		const rows = (await getQueue(ctx.client)).filter((r) => !statuses.length || statuses.includes(String(r.status)));
		return list(applyLimit(rows, limit).map(describeRow));
	},

	getState: async (ctx) => data(await getQueueState(ctx.client)),
};
