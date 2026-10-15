import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    describe,
    expect,
    it
} from 'vitest';

import { getUsagePaceIndicator } from '../../widgets/shared/usage-pace';
import {
    describeAccount,
    isMagpieUsageContext,
    parseMagpieQuotaResponse,
    resolveSessionAccount
} from '../magpie-usage';
import { resolveWeeklyUsageWindow } from '../usage-windows';

const GATEWAY_ENV = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425' };
const CHENJIAN = { provider: 'claude', email: 'chenjian@inhand.com' };
const CLAUDE_MODEL = { id: 'claude-opus-5-5', display_name: 'Opus 5.5' };

function claudeAccount(user: string, sessionUsed: number) {
    return {
        provider: 'claude',
        user,
        windows: [
            { name: '5 hours', used: sessionUsed, resetsAt: '2026-10-12T14:40:00+08:00' },
            { name: '7 days', used: 42, resetsAt: '2026-10-16T03:00:00+08:00' },
            { name: '7 days · Fable', used: 3, resetsAt: '2026-10-16T03:00:00+08:00' }
        ]
    };
}

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-usage-'));
}

describe('isMagpieUsageContext', () => {
    it('is true for a Claude model through the local gateway', () => {
        expect(isMagpieUsageContext({ model: CLAUDE_MODEL }, GATEWAY_ENV)).toBe(true);
    });

    it('is true for a routing group through the local gateway', () => {
        expect(isMagpieUsageContext({ model: { id: 'sonnet-tier' } }, GATEWAY_ENV)).toBe(true);
    });

    it('is false for a Claude model on the official endpoint or a remote relay', () => {
        expect(isMagpieUsageContext({ model: CLAUDE_MODEL }, {})).toBe(false);
        expect(isMagpieUsageContext({ model: CLAUDE_MODEL }, { ANTHROPIC_BASE_URL: 'https://ccr.inhand.design' })).toBe(false);
    });
});

describe('parseMagpieQuotaResponse', () => {
    const body = JSON.stringify({
        data: [
            claudeAccount('chenjian@inhand.com · Inhand', 10),
            claudeAccount('platform2@inhand.com · Inhand', 77),
            { provider: 'codex', user: 'chenjian@inhand.com', windows: [{ name: '5 hours', used: 5, resetsAt: 'r' }] }
        ]
    });

    it('maps the five-hour and seven-day windows of the requested account', () => {
        expect(parseMagpieQuotaResponse(body, CHENJIAN)).toEqual({
            sessionUsage: 10,
            sessionResetAt: '2026-10-12T14:40:00+08:00',
            weeklyUsage: 42,
            weeklyResetAt: '2026-10-16T03:00:00+08:00'
        });
    });

    it('gives two sessions on different accounts their own readings from the same response', () => {
        expect(parseMagpieQuotaResponse(body, CHENJIAN)?.sessionUsage).toBe(10);
        expect(parseMagpieQuotaResponse(body, { provider: 'claude', email: 'platform2@inhand.com' })?.sessionUsage).toBe(77);
    });

    it('reads the served provider\'s entry when the same email has several providers', () => {
        expect(parseMagpieQuotaResponse(body, { provider: 'codex', email: 'chenjian@inhand.com' })?.sessionUsage).toBe(5);
    });

    it('returns null for an unknown account rather than showing another account\'s numbers', () => {
        expect(parseMagpieQuotaResponse(body, { provider: 'claude', email: 'nobody@inhand.com' })).toBeNull();
        expect(parseMagpieQuotaResponse(body, undefined)).toBeNull();
    });

    it('reads an account without an email when its provider has exactly one account', () => {
        const kimi = { provider: 'kimi-code', user: null, windows: [{ name: '5 hours', used: 12, resetsAt: 'r' }] };

        expect(parseMagpieQuotaResponse(JSON.stringify({ data: [kimi] }), { provider: 'kimi-code' })?.sessionUsage).toBe(12);
        expect(parseMagpieQuotaResponse(JSON.stringify({ data: [kimi, { ...kimi, windows: [{ name: '5 hours', used: 80 }] }] }), { provider: 'kimi-code' })).toBeNull();
    });

    it('returns null for malformed input', () => {
        expect(parseMagpieQuotaResponse('not json', CHENJIAN)).toBeNull();
        expect(parseMagpieQuotaResponse('{}', CHENJIAN)).toBeNull();
    });

    it('reads a plan\'s Month window into the monthly fields beside its 5 hours and 7 days', () => {
        const body = JSON.stringify({
            data: [{
                provider: 'opencode-go',
                user: null,
                windows: [
                    { name: '5 hours', used: 1, resetsAt: '2026-10-15T11:18:51Z' },
                    { name: '7 days', used: 0 },
                    { name: 'Month', used: 24, resetsAt: '2026-11-11T04:24:00Z' }
                ]
            }]
        });

        const usage = parseMagpieQuotaResponse(body, { provider: 'opencode-go' });

        expect(usage).toEqual({
            sessionUsage: 1,
            sessionResetAt: '2026-10-15T11:18:51Z',
            weeklyUsage: 0,
            monthlyUsage: 24,
            monthlyResetAt: '2026-11-11T04:24:00Z'
        });
        expect(usage?.sessionWindowUnavailable).toBeUndefined();
    });

    it('keeps a Month window at 0% with no reset time, which magpie leaves out', () => {
        const body = JSON.stringify({
            data: [{
                provider: 'opencode-go',
                user: null,
                windows: [
                    { name: '5 hours', used: 0 },
                    { name: '7 days', used: 0 },
                    { name: 'Month', used: 0 }
                ]
            }]
        });

        const usage = parseMagpieQuotaResponse(body, { provider: 'opencode-go' });

        expect(usage?.monthlyUsage).toBe(0);
        expect(usage?.monthlyResetAt).toBeUndefined();
    });

    it('fills the weekly window from the Cursor Models window and no session window', () => {
        const body = JSON.stringify({
            data: [{
                provider: 'cursor',
                user: 'j3r0lin@gmail.com',
                windows: [
                    { name: 'Cursor Models', used: 18.48, resetsAt: '2026-11-01T00:00:00+08:00' },
                    { name: 'Other Models', used: 0, resetsAt: '2026-11-01T00:00:00+08:00' },
                    { name: 'On-demand', used: 0, resetsAt: '2026-11-01T00:00:00+08:00' },
                    { name: 'Total', used: 18.48, resetsAt: '2026-11-01T00:00:00+08:00' }
                ]
            }]
        });

        const usage = parseMagpieQuotaResponse(body, { provider: 'cursor', email: 'j3r0lin@gmail.com' });

        expect(usage).toEqual({ weeklyUsage: 18.48, weeklyResetAt: '2026-11-01T00:00:00+08:00', sessionWindowUnavailable: true });
        expect(usage?.sessionUsage).toBeUndefined();
        expect(usage?.monthlyUsage).toBeUndefined();
    });

    it('reads an unlisted provider by its 7 days window and marks the session window unavailable', () => {
        const body = JSON.stringify({
            data: [{
                provider: 'grok-plugin',
                user: 'j3r0lin@gmail.com',
                windows: [{ name: '7 days', used: 30, resetsAt: '2026-10-20T05:10:41.682Z' }]
            }]
        });

        const usage = parseMagpieQuotaResponse(body, { provider: 'grok-plugin', email: 'j3r0lin@gmail.com' });

        expect(usage?.weeklyUsage).toBe(30);
        expect(usage?.weeklyResetAt).toBe('2026-10-20T05:10:41.682Z');
        expect(usage?.sessionUsage).toBeUndefined();
        expect(usage?.sessionWindowUnavailable).toBe(true);
    });

    it('paces the Cursor Models window as seven days, not a 30-day cycle', () => {
        const body = JSON.stringify({
            data: [{
                provider: 'cursor',
                user: 'j3r0lin@gmail.com',
                windows: [{ name: 'Cursor Models', used: 25, resetsAt: '2026-10-20T13:10:00+08:00' }]
            }]
        });

        const usage = parseMagpieQuotaResponse(body, { provider: 'cursor', email: 'j3r0lin@gmail.com' });
        const now = Date.parse('2026-10-14T08:49:00+08:00');
        const window = resolveWeeklyUsageWindow(usage ?? {}, now);
        const elapsedPercent = window?.elapsedPercent ?? NaN;

        // 25% used with 11.7% of the week elapsed is 13 ahead. The same numbers
        // read against a 30-day cycle are 54 behind.
        expect(usage?.weeklyUsage).toBe(25);
        expect(elapsedPercent).toBeCloseTo(11.7, 1);
        expect(Math.round(25 - elapsedPercent)).toBe(13);
        expect(getUsagePaceIndicator(25, window, now)?.text).toBe('▴9');
    });

    it('returns no data for an unlisted provider whose windows are not named by length', () => {
        const copilot = { provider: 'copilot', user: 'j3r0lin@gmail.com', windows: [{ name: 'Chat requests', used: 40, resetsAt: 'r' }, { name: 'Completions', used: 10, resetsAt: 'r' }] };
        const body = JSON.stringify({ data: [copilot] });

        expect(parseMagpieQuotaResponse(body, { provider: 'copilot', email: 'j3r0lin@gmail.com' })).toBeNull();
    });
});

describe('resolveSessionAccount', () => {
    function setup() {
        const dir = tempDir();
        const affinityFile = path.join(dir, 'affinity.json');
        fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'Chenjian@inhand.com' } }));
        fs.writeFileSync(affinityFile, JSON.stringify({
            'claude/claude-opus-5-5|session-a': { who: 'claude@platform2@inhand.com · inhand', at: '2026-10-12T10:00:00+08:00' },
            'claude/claude-haiku-5-5|session-a': { who: 'claude@platform1@inhand.com · inhand', at: '2026-10-12T11:00:00+08:00' },
            'group/sonnet-tier|session-b': { who: 'codex@someone@gmail.com', at: '2026-10-12T10:00:00+08:00' },
            'group/sonnet-tier|session-c': { who: 'claude@platform1@inhand.com · inhand', at: '2026-10-12T10:00:00+08:00' },
            'group/sonnet-tier|session-e': { who: 'kimi-code#670d5e5763', at: '2026-10-12T10:00:00+08:00' }
        }));
        return { affinityFile, environment: { CLAUDE_CONFIG_DIR: dir } };
    }

    it('uses the account magpie pinned this session\'s main model to, not a subagent model\'s', () => {
        const { affinityFile, environment } = setup();

        expect(resolveSessionAccount('session-a', 'claude-opus-5-5', environment, affinityFile)).toEqual({ provider: 'claude', email: 'platform2@inhand.com', routed: false });
    });

    it('follows a routing group to whichever provider served this session', () => {
        const { affinityFile, environment } = setup();

        expect(resolveSessionAccount('session-b', 'sonnet-tier', environment, affinityFile)).toEqual({ provider: 'codex', email: 'someone@gmail.com', routed: true });
        expect(resolveSessionAccount('session-c', 'sonnet-tier', environment, affinityFile)).toEqual({ provider: 'claude', email: 'platform1@inhand.com', routed: true });
    });

    it('resolves a provider whose accounts magpie names by id instead of email', () => {
        const { affinityFile, environment } = setup();

        expect(resolveSessionAccount('session-e', 'sonnet-tier', environment, affinityFile)).toEqual({ provider: 'kimi-code', email: undefined, routed: true });
    });

    it('finds the routing group when Claude Code reports it as group/<name>', () => {
        const { affinityFile, environment } = setup();

        expect(resolveSessionAccount('session-b', 'group/sonnet-tier', environment, affinityFile)).toEqual({ provider: 'codex', email: 'someone@gmail.com', routed: true });
    });

    it('uses the Claude Code login for a Claude session that was never pinned', () => {
        const { affinityFile, environment } = setup();

        expect(resolveSessionAccount('session-d', 'claude-opus-5-5', environment, affinityFile)).toEqual(CHENJIAN);
    });

    it('is undefined for a routing group that has not served this session yet', () => {
        const { affinityFile, environment } = setup();

        expect(resolveSessionAccount('session-d', 'sonnet-tier', environment, affinityFile)).toBeUndefined();
    });
});

describe('describeAccount', () => {
    it('counts the provider\'s accounts and gives the account\'s alias', () => {
        const cacheFile = path.join(tempDir(), 'magpie-usage.json');
        fs.writeFileSync(cacheFile, JSON.stringify({
            data: [
                { ...claudeAccount('a@inhand.com · Inhand', 1), alias: 'p1' },
                { provider: 'claude', user: 'b@gmail.com', windows: [] },
                { provider: 'codex', user: 'c@gmail.com', windows: [] }
            ]
        }));

        expect(describeAccount({ provider: 'claude', email: 'a@inhand.com' }, cacheFile)).toEqual({ providerAccountCount: 2, alias: 'p1' });
        expect(describeAccount({ provider: 'claude', email: 'b@gmail.com' }, cacheFile)).toEqual({ providerAccountCount: 2, alias: undefined });
        expect(describeAccount({ provider: 'codex', email: 'c@gmail.com' }, cacheFile)?.providerAccountCount).toBe(1);
    });

    it('is undefined without a cached reading', () => {
        expect(describeAccount({ provider: 'claude', email: 'a@inhand.com' }, path.join(tempDir(), 'missing.json'))).toBeUndefined();
    });
});
