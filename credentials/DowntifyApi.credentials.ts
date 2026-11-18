import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Downtify API credential: Base URL and a device token, sent as `Authorization: Bearer`.
 *
 * The node never signs in with a username and password: every sign-in creates a new paired
 * device in Downtify. The token is created once (POST /api/auth/token, see the README).
 */
export class DowntifyApi implements ICredentialType {
	name = 'downtifyApi';

	displayName = 'Downtify API';

	icon: Icon = { light: 'file:../icons/downtify.svg', dark: 'file:../icons/downtify.dark.svg' };

	documentationUrl = 'https://github.com/FDalCol/n8n-nodes-downtify#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'http://downtify.local:8000',
			description:
				'Address of the Downtify server (http:// or https://, optional path prefix of a reverse proxy). Must not contain credentials, query or fragment.',
		},
		{
			displayName: 'Device Token',
			name: 'deviceToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			placeholder: 'dtfy_…',
			description:
				'Device token of a paired app (dtfy_…), sent as Authorization: Bearer. Leave empty only if the server runs with DOWNTIFY_DISABLE_AUTH=true.',
		},
		{
			displayName:
				'Create the token once with POST /api/auth/token (see the README), preferably for a dedicated non-admin user. The node never signs in with a username and password.',
			name: 'setupNotice',
			type: 'notice',
			default: '',
		},
	];

	authenticate = async (
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> => {
		const token = String(credentials.deviceToken ?? '').trim();
		if (token === '') return requestOptions;
		return {
			...requestOptions,
			headers: {
				...(requestOptions.headers ?? {}),
				Authorization: `Bearer ${token}`,
			},
		};
	};

	test: ICredentialTestRequest = {
		request: {
			// http(s) only, without credentials, query or fragment. Anything else resolves to an
			// unreachable .invalid host, so the test fails without contacting any server.
			baseURL:
				'={{ /^https?:\\/\\/[^\\/@?#]+(\\/[^?#@]*)?$/i.test(String($credentials.baseUrl || "").trim()) ? String($credentials.baseUrl).trim().replace(/\\/+$/, "") : "https://base-url-must-be-http-or-https-without-credentials-query-or-fragment.invalid" }}',
			url: '/api/me',
			method: 'GET',
			headers: {
				Accept: 'application/json',
			},
			disableFollowRedirect: true,
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message:
						'Authentication failed (401): the device token is wrong or was revoked, or the server requires a token',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 403,
					message: 'Access denied (403): the server refused the device token for GET /api/me',
				},
			},
		],
	};
}
