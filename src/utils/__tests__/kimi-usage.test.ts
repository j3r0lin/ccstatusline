import { EventEmitter } from 'events';
import type {
    ClientRequest,
    IncomingMessage
} from 'http';
import type * as https from 'https';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    __testing,
    getKimiUsageEndpoint,
    isKimiUsageContext,
    parseKimiSubscriptionStats,
    parseKimiUsageResponse,
    resolveKimiCodeApiKey
} from '../kimi-usage';

interface MockWebRequest {
    body: string;
    headers: Record<string, string>;
    url: string;
}

function createWebRequester(responses: { body: string; statusCode: number }[]): {
    requests: MockWebRequest[];
    requester: typeof https.request;
} {
    const requests: MockWebRequest[] = [];
    const requester = ((url: string | URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
        const requestEvents = new EventEmitter();
        const request = {
            destroy() { return request; },
            end(body = '') {
                const next = responses.shift();
                if (!next) {
                    requestEvents.emit('error', new Error('Unexpected request'));
                    return;
                }

                requests.push({
                    url: url.toString(),
                    headers: options.headers as Record<string, string>,
                    body
                });
                const response = new EventEmitter() as IncomingMessage;
                response.statusCode = next.statusCode;
                response.setEncoding = () => response;
                callback(response);
                if (next.body) {
                    response.emit('data', next.body);
                }
                response.emit('end');
            },
            on(event: string, handler: (...args: unknown[]) => void) {
                requestEvents.on(event, handler);
                return request;
            }
        };
        return request as unknown as ClientRequest;
    }) as typeof https.request;

    return { requester, requests };
}

describe('Kimi usage context detection', () => {
    it.each([
        { model: 'kimi-k2.5' },
        { model: { id: 'moonshotai/kimi-k2-instruct' } },
        { model: { display_name: 'Kimi K2 Thinking' } }
    ])('detects Kimi from the status model', ({ model }) => {
        expect(isKimiUsageContext({ model }, {})).toBe(true);
    });

    it('detects Kimi from the configured API host when status model is absent', () => {
        expect(isKimiUsageContext(
            {},
            { ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/' }
        )).toBe(true);
    });

    it('detects Kimi from the configured API host when the status model is an opaque alias', () => {
        expect(isKimiUsageContext(
            { model: { id: 'k3-256k' } },
            { ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/' }
        )).toBe(true);
    });

    it('does not classify an Anthropic model as Kimi even when env points at Kimi', () => {
        expect(isKimiUsageContext(
            { model: { id: 'claude-sonnet-4-5' } },
            {
                ANTHROPIC_MODEL: 'kimi-k2.5',
                ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/'
            }
        )).toBe(false);
    });
});

describe('Kimi Code API key resolution', () => {
    it('prefers the dedicated Kimi Code API key', () => {
        expect(resolveKimiCodeApiKey({
            KIMI_CODE_API_KEY: 'dedicated-key',
            ANTHROPIC_AUTH_TOKEN: 'claude-token',
            ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/'
        })).toBe('dedicated-key');
    });

    it('reuses the Claude auth token for the official Kimi API host', () => {
        expect(resolveKimiCodeApiKey({
            ANTHROPIC_AUTH_TOKEN: 'kimi-key',
            ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/'
        })).toBe('kimi-key');
    });

    it('does not send a Claude auth token to a non-Kimi usage endpoint', () => {
        expect(resolveKimiCodeApiKey({
            ANTHROPIC_AUTH_TOKEN: 'anthropic-key',
            ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
        })).toBeUndefined();
    });
});

describe('Kimi usage response parsing', () => {
    it('maps weekly and five-hour request quotas to shared usage fields', () => {
        const result = parseKimiUsageResponse(JSON.stringify({
            usage: {
                limit: '2048',
                used: '512',
                remaining: '1536',
                resetTime: '2030-01-07T00:00:00Z'
            },
            limits: [{
                window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
                detail: {
                    limit: 200,
                    used: 50,
                    remaining: 150,
                    reset_at: '2030-01-01T05:00:00Z'
                }
            }]
        }));

        expect(result).toEqual({
            weeklyUsage: 25,
            weeklyResetAt: '2030-01-07T00:00:00Z',
            sessionUsage: 25,
            sessionResetAt: '2030-01-01T05:00:00Z'
        });
    });

    it('derives used requests from limit minus remaining', () => {
        const result = parseKimiUsageResponse(JSON.stringify({
            usage: {
                limit: 1000,
                remaining: 750
            },
            limits: []
        }));

        expect(result?.weeklyUsage).toBe(25);
        expect(result?.sessionUsage).toBeUndefined();
    });

    it('rejects malformed responses', () => {
        expect(parseKimiUsageResponse('{"usage":{"remaining":"10"}}')).toBeNull();
        expect(parseKimiUsageResponse('not-json')).toBeNull();
    });
});

describe('Kimi subscription stats authentication', () => {
    it('uses Bearer access without the legacy kimi-auth cookie', async () => {
        const { requester, requests } = createWebRequester([{
            statusCode: 200,
            body: '{"subscriptionBalance":{"amountUsedRatio":0.25}}'
        }]);

        await expect(__testing.fetchKimiSubscriptionStats({ accessToken: 'fake-access' }, requester))
            .resolves.toContain('amountUsedRatio');
        expect(requests).toHaveLength(1);
        expect(requests[0]?.headers.Authorization).toBe('Bearer fake-access');
        expect(requests[0]?.headers.Cookie).toBeUndefined();
        expect(requests[0]?.headers.Origin).toBe('https://www.kimi.com');
        expect(requests[0]?.headers.Referer).toBe('https://www.kimi.com/code/console');
        expect(requests[0]?.headers['connect-protocol-version']).toBe('1');
        expect(requests[0]?.headers['x-msh-platform']).toBe('web');
    });

    it('refreshes after a 401 and retries stats once with the new access token', async () => {
        const statsBody = '{"subscriptionBalance":{"amountUsedRatio":0.5}}';
        const { requester, requests } = createWebRequester([
            { statusCode: 401, body: '{"code":"unauthenticated"}' },
            { statusCode: 200, body: '{"accessToken":"fresh-access","refreshToken":"fresh-refresh"}' },
            { statusCode: 200, body: statsBody }
        ]);

        await expect(__testing.fetchKimiSubscriptionStats({
            accessToken: 'expired-access',
            refreshToken: 'valid-refresh'
        }, requester)).resolves.toBe(statsBody);

        expect(requests.map(request => request.url)).toEqual([
            'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats',
            'https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken',
            'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats'
        ]);
        expect(requests[1]?.body).toBe('{"refresh_token":"valid-refresh"}');
        expect(requests[2]?.headers.Authorization).toBe('Bearer fresh-access');
    });

    it('refreshes before stats when only a refresh token is available', async () => {
        const statsBody = '{"subscriptionBalance":{"amountUsedRatio":0.75}}';
        const { requester, requests } = createWebRequester([
            { statusCode: 200, body: '{"accessToken":"fresh-access"}' },
            { statusCode: 200, body: statsBody }
        ]);

        await expect(__testing.fetchKimiSubscriptionStats({ refreshToken: 'valid-refresh' }, requester))
            .resolves.toBe(statsBody);
        expect(requests).toHaveLength(2);
        expect(requests[0]?.body).toBe('{"refresh_token":"valid-refresh"}');
        expect(requests[1]?.headers.Authorization).toBe('Bearer fresh-access');
    });
});

describe('Kimi subscription stats parsing', () => {
    it('maps the monthly pool ratio and expiry to shared usage fields', () => {
        const result = parseKimiSubscriptionStats(JSON.stringify({
            ratelimitCode5h: { ratio: 0.1, enabled: true, resetTime: '2030-01-01T05:00:00Z' },
            ratelimitCode7d: { ratio: 0.02, enabled: true, resetTime: '2030-01-07T00:00:00Z' },
            subscriptionBalance: {
                feature: 'FEATURE_OMNI',
                type: 'SUBSCRIPTION',
                amountUsedRatio: 0.0625,
                kimiCodeUsedRatio: 0.03125,
                expireTime: '2030-02-12T12:24:00Z'
            }
        }));

        expect(result).toEqual({
            monthlyUsage: 6.25,
            monthlyResetAt: '2030-02-12T12:24:00Z'
        });
    });

    it('rejects responses without a usable balance ratio', () => {
        expect(parseKimiSubscriptionStats('{}')).toBeNull();
        expect(parseKimiSubscriptionStats('{"subscriptionBalance":{}}')).toBeNull();
        expect(parseKimiSubscriptionStats('not-json')).toBeNull();
    });
});

describe('Kimi usage endpoint', () => {
    it('builds the official usage endpoint by default', () => {
        expect(getKimiUsageEndpoint({})?.toString()).toBe('https://api.kimi.com/coding/v1/usages');
    });

    it('accepts a compatible HTTPS base URL', () => {
        expect(getKimiUsageEndpoint({ KIMI_CODE_BASE_URL: 'https://proxy.example.com/kimi/coding/v1' })?.toString())
            .toBe('https://proxy.example.com/kimi/coding/v1/usages');
    });

    it('rejects insecure endpoint overrides', () => {
        expect(getKimiUsageEndpoint({ KIMI_CODE_BASE_URL: 'http://api.kimi.com' })).toBeNull();
    });
});
