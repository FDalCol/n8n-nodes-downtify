import type { IDataObject } from 'n8n-workflow';

import { SecurityError } from './security';

/** Decodes the (already buffered) response body; the size is checked again as a safety net. */
export function readBody(body: unknown, maxBytes: number): string {
	if (body === undefined || body === null) return '';
	if (typeof body === 'string') {
		if (Buffer.byteLength(body) > maxBytes) throw new SecurityError('Response too large');
		return body;
	}
	if (Buffer.isBuffer(body) || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
		const buf = Buffer.isBuffer(body)
			? body
			: body instanceof ArrayBuffer
				? Buffer.from(body)
				: Buffer.from(body.buffer, body.byteOffset, body.byteLength);
		if (buf.length > maxBytes) throw new SecurityError('Response too large');
		return buf.toString('utf8');
	}
	return JSON.stringify(body);
}

export function tooLargeMessage(maxBytes: number): string {
	return `Response too large (more than ${Math.round(maxBytes / 1024 / 1024)} MiB), aborted`;
}

export function describeNetworkError(error: unknown, includeRawMessage = true): { message: string; description?: string } {
	const e = error as {
		code?: string;
		message?: string;
		description?: string;
		cause?: { code?: string; message?: string; cause?: { code?: string; message?: string } };
		context?: { data?: { code?: string } };
	};
	const haystack = [
		e?.code,
		e?.cause?.code,
		e?.cause?.cause?.code,
		e?.context?.data?.code,
		e?.message,
		e?.description,
		e?.cause?.message,
		e?.cause?.cause?.message,
	]
		.filter((x) => typeof x === 'string')
		.join(' ');
	if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|certificate|ERR_TLS_CERT/i.test(haystack)) {
		return {
			message: 'TLS certificate of the Downtify server is not trusted (self-signed, expired or wrong host name)',
			description: 'Use a trusted certificate on the reverse proxy in front of Downtify.',
		};
	}
	if (/EPROTO|wrong version number|SSL routines|ERR_SSL/i.test(haystack)) {
		return {
			message: 'TLS handshake with the Downtify server failed',
			description: 'Check whether the Base URL should use http:// or https://.',
		};
	}
	if (/ECONNREFUSED/.test(haystack)) return { message: 'Connection refused by the Downtify server', description: 'Check host and port of the Base URL.' };
	if (/ENOTFOUND|EAI_AGAIN/.test(haystack)) return { message: 'Downtify host not found', description: 'Check the host name of the Base URL.' };
	if (/ETIMEDOUT|ECONNABORTED|timeout/i.test(haystack)) return { message: 'Request to Downtify timed out' };
	if (/ECONNRESET|socket hang up/i.test(haystack)) return { message: 'Connection to Downtify was reset' };
	if (/cancel|abort/i.test(haystack)) return { message: 'Request to Downtify was cancelled' };
	return {
		message: 'Request to Downtify failed',
		description: includeRawMessage && typeof e?.message === 'string' ? e.message : undefined,
	};
}

/** FastAPI error detail: a string, or a list of validation errors. */
export function errorDetail(body: unknown): string {
	if (!body || typeof body !== 'object') return '';
	const detail = (body as IDataObject).detail;
	if (typeof detail === 'string') return detail.trim().slice(0, 2000);
	if (Array.isArray(detail)) {
		return detail
			.map((d) => {
				if (!d || typeof d !== 'object') return String(d);
				const loc = Array.isArray((d as IDataObject).loc) ? ((d as IDataObject).loc as unknown[]).join('.') : '';
				const msg = typeof (d as IDataObject).msg === 'string' ? ((d as IDataObject).msg as string) : JSON.stringify(d);
				return loc ? `${loc}: ${msg}` : msg;
			})
			.join('; ')
			.slice(0, 2000);
	}
	if (detail && typeof detail === 'object') return JSON.stringify(detail).slice(0, 2000);
	return '';
}
