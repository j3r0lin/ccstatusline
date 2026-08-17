import {
    describe,
    expect,
    it
} from 'vitest';

import {
    getKimiUsageEndpoint,
    isKimiUsageContext,
    parseKimiUsageResponse,
    resolveKimiCodeApiKey
} from '../kimi-usage';

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
