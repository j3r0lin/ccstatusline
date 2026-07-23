import {
    describe,
    expect,
    it
} from 'vitest';

import {
    getCodexAuthFilePath,
    getCodexHomeURL,
    getCodexUsageEndpoint,
    isCodexApiUrl,
    isCodexUsageContext,
    parseCodexAuthJson,
    parseCodexUsageResponse
} from '../codex-usage';

describe('Codex usage context detection', () => {
    it.each([
        { model: 'gpt-5.3-codex' },
        { model: { id: 'openai/codex-mini' } },
        { model: { display_name: 'GPT-5 Codex' } },
        { model: { id: 'chatgpt-codex' } },
        { model: 'gpt-5.6-sol' },
        { model: { id: 'gpt-5.6-terra' } },
        { model: { id: 'openai/gpt-5.6-luna' } },
        { model: 'terra' },
        { model: { display_name: 'Sol' } },
        { model: 'gpt-5.6' }
    ])('detects Codex from the status model', ({ model }) => {
        expect(isCodexUsageContext({ model }, {})).toBe(true);
    });

    it('does not treat unrelated short words as Codex tiers', () => {
        expect(isCodexUsageContext({ model: { id: 'solar-pro' } }, {})).toBe(false);
        expect(isCodexUsageContext({ model: { id: 'claude-sonnet-4-5' } }, {})).toBe(false);
    });

    it('detects Codex from the configured API host when status model is absent', () => {
        expect(isCodexUsageContext(
            {},
            { ANTHROPIC_BASE_URL: 'https://chatgpt.com/backend-api' }
        )).toBe(true);
        expect(isCodexUsageContext(
            {},
            { ANTHROPIC_BASE_URL: 'https://api.openai.com/v1' }
        )).toBe(true);
    });

    it('does not classify an Anthropic model as Codex even when env points at OpenAI', () => {
        expect(isCodexUsageContext(
            { model: { id: 'claude-sonnet-4-5' } },
            {
                ANTHROPIC_MODEL: 'gpt-5-codex',
                ANTHROPIC_BASE_URL: 'https://api.openai.com'
            }
        )).toBe(false);
    });
});

describe('Codex API URL detection', () => {
    it('accepts ChatGPT and OpenAI hosts', () => {
        expect(isCodexApiUrl('https://chatgpt.com/backend-api')).toBe(true);
        expect(isCodexApiUrl('https://api.openai.com/v1')).toBe(true);
        expect(isCodexApiUrl('https://chat.openai.com')).toBe(true);
        expect(isCodexApiUrl('https://api.anthropic.com')).toBe(false);
    });
});

describe('Codex paths', () => {
    it('resolves CODEX_HOME and auth.json', () => {
        expect(getCodexHomeURL({ CODEX_HOME: '/tmp/codex-home' }, '/Users/me')).toBe('/tmp/codex-home');
        expect(getCodexAuthFilePath({}, '/Users/me')).toBe('/Users/me/.codex/auth.json');
    });

    it('defaults the usage endpoint and accepts overrides', () => {
        expect(getCodexUsageEndpoint({})?.toString()).toBe('https://chatgpt.com/backend-api/wham/usage');
        expect(getCodexUsageEndpoint({ CODEX_USAGE_URL: 'https://example.com/usage' })?.toString())
            .toBe('https://example.com/usage');
        expect(getCodexUsageEndpoint({ CODEX_USAGE_URL: 'http://insecure.example/usage' })).toBeNull();
    });
});

describe('Codex auth.json parsing', () => {
    it('reads OAuth tokens from the Codex CLI auth file shape', () => {
        const credentials = parseCodexAuthJson(JSON.stringify({
            auth_mode: 'chatgpt',
            last_refresh: '2026-07-18T12:29:53Z',
            tokens: {
                access_token: 'access-1',
                refresh_token: 'refresh-1',
                account_id: 'acct-1',
                id_token: 'id-1'
            }
        }));

        expect(credentials).toEqual({
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
            accountId: 'acct-1',
            idToken: 'id-1',
            lastRefresh: '2026-07-18T12:29:53Z'
        });
    });

    it('falls back to OPENAI_API_KEY when tokens are absent', () => {
        expect(parseCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: 'sk-test' }))).toEqual({
            accessToken: 'sk-test',
            refreshToken: undefined,
            accountId: undefined,
            idToken: undefined,
            lastRefresh: undefined
        });
    });

    it('rejects empty payloads', () => {
        expect(parseCodexAuthJson('{}')).toBeNull();
        expect(parseCodexAuthJson('not-json')).toBeNull();
    });
});

describe('Codex usage response parsing', () => {
    it('maps primary/secondary windows to session and weekly usage', () => {
        const result = parseCodexUsageResponse(JSON.stringify({
            plan_type: 'plus',
            rate_limit: {
                primary_window: {
                    used_percent: 42,
                    reset_at: 1893456000,
                    limit_window_seconds: 18000
                },
                secondary_window: {
                    used_percent: 15,
                    reset_at: 1894060800,
                    limit_window_seconds: 604800
                }
            }
        }));

        expect(result).toEqual({
            sessionUsage: 42,
            sessionResetAt: '2030-01-01T00:00:00.000Z',
            weeklyUsage: 15,
            weeklyResetAt: '2030-01-08T00:00:00.000Z'
        });
    });

    it('accepts camelCase window fields', () => {
        const result = parseCodexUsageResponse(JSON.stringify({
            rateLimit: {
                primaryWindow: {
                    usedPercent: 10,
                    resetAt: 1893456000
                }
            }
        }));

        expect(result?.sessionUsage).toBe(10);
        expect(result?.sessionResetAt).toBe('2030-01-01T00:00:00.000Z');
        expect(result?.weeklyUsage).toBeUndefined();
    });

    it('rejects responses without usable windows', () => {
        expect(parseCodexUsageResponse('{"rate_limit":{}}')).toBeNull();
        expect(parseCodexUsageResponse('not-json')).toBeNull();
    });
});
