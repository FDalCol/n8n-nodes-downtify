import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IDataObject,
	IHttpRequestHelper,
	IHttpRequestOptions,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

import { credentialToken, preAuthenticate } from '../nodes/Downtify/shared/auth';

/**
 * Username & Password: preAuthentication signs in with POST /api/auth/token and n8n stores the
 * device token in the hidden, expirable `sessionToken` field. n8n 2.45 runs it again only when
 * that field is empty, after a 401 and on every credential test.
 */
export class DowntifyApi implements ICredentialType {
	name = 'downtifyApi';

	displayName = 'Downtify API';

	icon: Icon = { light: 'file:../icons/downtify.svg', dark: 'file:../icons/downtify.dark.svg' };

	documentationUrl = 'https://github.com/FDalCol/n8n-nodes-downtify#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'options',
			options: [
				{
					name: 'Device Token',
					value: 'deviceToken',
					description: 'Use a device token created in Downtify',
				},
				{
					name: 'Username & Password',
					value: 'password',
					description: 'Sign in once and keep the device token Downtify returns',
				},
			],
			default: 'password',
			description:
				'Username & Password signs in with POST /api/auth/token and stores the device token in the credential; it signs in again only when Downtify rejects the token (401). Every sign-in adds a device named "n8n" under Settings > Apps in Downtify. The Test button (also run automatically on Save) signs in again whenever the credential has no valid token yet, for example right after you create or change it, so it can add a new device each time.',
		},
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
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
			description: 'Downtify user, preferably a dedicated non-admin user for n8n',
			displayOptions: { show: { authentication: ['password'] } },
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			displayOptions: { show: { authentication: ['password'] } },
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
			displayOptions: { show: { authentication: ['deviceToken'] } },
		},
		{
			displayName: 'Session Token',
			name: 'sessionToken',
			type: 'hidden',
			// expirable: n8n runs preAuthentication when it is empty and after a 401.
			// password: n8n never sends the stored value to the browser.
			typeOptions: { expirable: true, password: true },
			default: '',
		},
		{
			displayName: 'Session Token Fingerprint',
			name: 'sessionTokenFingerprint',
			type: 'hidden',
			// Derived from the password and the token: never sent to the browser either.
			typeOptions: { password: true },
			default: '',
		},
	];

	async preAuthentication(this: IHttpRequestHelper, credentials: ICredentialDataDecryptedObject): Promise<IDataObject> {
		return await preAuthenticate(this.helpers, credentials);
	}

	authenticate = async (
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> => {
		let token: string;
		try {
			token = credentialToken(credentials);
		} catch {
			token = '';
		}
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
