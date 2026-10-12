import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    isMagpieUsageContext,
    parseMagpieQuotaResponse,
    resolveSessionAccount
} from '../magpie-usage';

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

    it('maps the five-hour, seven-day and Fable windows of the requested account', () => {
        expect(parseMagpieQuotaResponse(body, CHENJIAN)).toEqual({
            sessionUsage: 10,
            sessionResetAt: '2026-10-12T14:40:00+08:00',
            weeklyUsage: 42,
            weeklyResetAt: '2026-10-16T03:00:00+08:00',
            fableUsage: 3,
            fableResetAt: '2026-10-16T03:00:00+08:00'
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

    it('returns null for malformed input', () => {
        expect(parseMagpieQuotaResponse('not json', CHENJIAN)).toBeNull();
        expect(parseMagpieQuotaResponse('{}', CHENJIAN)).toBeNull();
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
            'group/sonnet-tier|session-c': { who: 'claude@platform1@inhand.com · inhand', at: '2026-10-12T10:00:00+08:00' }
        }));
        return { affinityFile, environment: { CLAUDE_CONFIG_DIR: dir } };
    }

    it('uses the account magpie pinned this session\'s main model to, not a subagent model\'s', () => {
        const { affinityFile, environment } = setup();

        expect(resolveSessionAccount('session-a', 'claude-opus-5-5', environment, affinityFile)).toEqual({ provider: 'claude', email: 'platform2@inhand.com' });
    });

    it('follows a routing group to whichever provider served this session', () => {
        const { affinityFile, environment } = setup();

        expect(resolveSessionAccount('session-b', 'sonnet-tier', environment, affinityFile)).toEqual({ provider: 'codex', email: 'someone@gmail.com' });
        expect(resolveSessionAccount('session-c', 'sonnet-tier', environment, affinityFile)).toEqual({ provider: 'claude', email: 'platform1@inhand.com' });
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
