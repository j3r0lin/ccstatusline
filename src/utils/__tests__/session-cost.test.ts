import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import modelPrices from '../../data/model-prices.json';
import type { ModelPrices } from '../../types/ModelPrice';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import { SessionCostWidget } from '../../widgets/SessionCost';
import {
    getSessionCostSummary,
    resolveSessionCost
} from '../session-cost';

/** Round prices under real alias keys, so a refresh of the committed table cannot move these expectations. */
const FIXTURE_PRICES: ModelPrices = {
    'moonshotai/kimi-k3': { input: 1, output: 10, cache_read: 0.5, cache_write: 2 },
    'zai/glm-5.3': { input: 2, output: 4 },
    'anthropic/claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
    'xai/grok-4.7': {
        input: 2,
        output: 6,
        cache_read: 0.5,
        tiers: [{ input: 4, output: 12, cache_read: 1, tier: { type: 'context', size: 200_000 } }]
    }
};

/** A fresh price cache keeps the default price lookup from spawning a background refresh. */
function seedFreshPriceCache(home: string): void {
    const dir = path.join(home, '.cache', 'ccstatusline');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'model-prices.json'), JSON.stringify(modelPrices));
}

interface Usage {
    input?: number;
    output?: number;
    cacheRead?: number;
    write5m?: number;
    write1h?: number;
    /** Report only the combined count, without the 5m/1h breakdown */
    combinedWrite?: number;
}

function assistantLine(id: string, model: string, usage: Usage): string {
    return JSON.stringify({
        type: 'assistant',
        message: {
            id,
            model,
            usage: {
                input_tokens: usage.input ?? 0,
                output_tokens: usage.output ?? 0,
                cache_read_input_tokens: usage.cacheRead ?? 0,
                cache_creation_input_tokens: usage.combinedWrite ?? ((usage.write5m ?? 0) + (usage.write1h ?? 0)),
                ...(usage.combinedWrite === undefined
                    ? {
                        cache_creation: {
                            ephemeral_5m_input_tokens: usage.write5m ?? 0,
                            ephemeral_1h_input_tokens: usage.write1h ?? 0
                        }
                    }
                    : {})
            }
        }
    });
}

const MILLION = 1_000_000;

describe('session cost at per-model API prices', () => {
    let tempDir: string;
    let transcript: string;

    function total(): number | undefined {
        return getSessionCostSummary(transcript, FIXTURE_PRICES)?.total;
    }

    function write(lines: string[]): void {
        fs.writeFileSync(transcript, `${lines.join('\n')}\n`, 'utf-8');
    }

    function append(lines: string[]): void {
        fs.appendFileSync(transcript, `${lines.join('\n')}\n`, 'utf-8');
    }

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-session-cost-'));
        vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
        seedFreshPriceCache(tempDir);
        transcript = path.join(tempDir, 'sess.jsonl');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('prices each message by its own model in a mixed session', () => {
        write([
            assistantLine('a', 'k3-256k', { input: MILLION, output: 100_000 }),
            assistantLine('b', 'glm-5.3', { input: MILLION, output: MILLION })
        ]);

        // kimi: 1 + 1; glm: 2 + 4
        expect(total()).toBeCloseTo(8, 6);
    });

    it('prices a model name whatever its casing', () => {
        write([assistantLine('a', 'GLM-5.3', { input: MILLION, output: MILLION })]);

        expect(total()).toBeCloseTo(6, 6);
    });

    it('counts a message once however many lines carry its id', () => {
        const line = assistantLine('a', 'k3-256k', { input: MILLION });
        write([line, line, line]);

        expect(total()).toBeCloseTo(1, 6);
    });

    it('prices a message at its final usage when later lines of the same id grow', () => {
        write([
            assistantLine('a', 'k3-256k', { input: MILLION, output: 7 }),
            assistantLine('a', 'k3-256k', { input: MILLION, output: 464 }),
            assistantLine('b', 'k3-256k', { input: MILLION })
        ]);

        expect(total()).toBeCloseTo(2 + 464 * 10 / MILLION, 9);
    });

    it('takes the settled usage when input moves into the cache read on a later line', () => {
        write([
            assistantLine('a', 'k3-256k', { input: MILLION }),
            assistantLine('a', 'k3-256k', { input: 100_000, output: 1000, cacheRead: 900_000 })
        ]);

        // 0.1 + 0.01 + 0.45, not the larger of each field
        expect(total()).toBeCloseTo(0.56, 6);
    });

    it('prices the final usage when a message grows across two incremental reads', () => {
        write([assistantLine('a', 'k3-256k', { input: MILLION, output: 7 })]);
        expect(total()).toBeCloseTo(1 + 7 * 10 / MILLION, 9);

        append([
            assistantLine('a', 'k3-256k', { input: MILLION, output: 464 }),
            assistantLine('b', 'k3-256k', { output: 100 })
        ]);
        expect(total()).toBeCloseTo(1 + 464 * 10 / MILLION + 100 * 10 / MILLION, 9);
    });

    it('includes subagent transcripts', () => {
        write([assistantLine('a', 'k3-256k', { input: MILLION })]);
        const subagents = path.join(tempDir, 'sess', 'subagents');
        fs.mkdirSync(subagents, { recursive: true });
        fs.writeFileSync(
            path.join(subagents, 'agent-1.jsonl'),
            `${assistantLine('s1', 'glm-5.3', { input: MILLION })}\n`,
            'utf-8'
        );
        fs.writeFileSync(path.join(subagents, 'agent-1.meta.json'), '{"input_tokens":5}', 'utf-8');

        expect(total()).toBeCloseTo(3, 6);
    });

    it('prices 5m cache writes at the cache write price and 1h writes at twice the input price', () => {
        write([
            assistantLine('a', 'claude-sonnet-5-5', { write5m: MILLION }),
            assistantLine('b', 'claude-sonnet-5-5', { write1h: MILLION })
        ]);

        expect(total()).toBeCloseTo(2.5 + 2 * 2, 6);
    });

    it('treats a combined cache creation count without a breakdown as 5m writes', () => {
        write([assistantLine('a', 'k3-256k', { combinedWrite: MILLION })]);

        expect(total()).toBeCloseTo(2, 6);
    });

    it('prices cache writes at the input price when the entry has no cache write price', () => {
        write([assistantLine('a', 'glm-5.3', { write5m: MILLION })]);

        expect(total()).toBeCloseTo(2, 6);
    });

    it('switches to the higher price tier when the prompt exceeds the tier size', () => {
        write([
            assistantLine('a', 'grok-4.7', { input: 100_000 }),
            assistantLine('b', 'grok-4.7', { input: 250_000 })
        ]);

        // 0.1M at 2, 0.25M at the tier's 4
        expect(total()).toBeCloseTo(0.2 + 1, 6);
    });

    it('prices a tier that omits cache write at the tier input price, not the base one', () => {
        write([assistantLine('a', 'grok-4.7', { input: 1, write5m: 250_000 })]);

        expect(total()).toBeCloseTo(250_000 * 4 / MILLION + 4 / MILLION, 9);
    });

    it('reports a model without a price as unknown', () => {
        write([
            assistantLine('a', 'k3-256k', { input: MILLION }),
            assistantLine('b', 'mystery-model', { input: MILLION })
        ]);

        expect(getSessionCostSummary(transcript, FIXTURE_PRICES)).toMatchObject({ hasUnknown: true, allClaude: false });
    });

    it('reports an all-Claude session as such', () => {
        write([assistantLine('a', 'claude-sonnet-5-5', { input: MILLION })]);

        expect(getSessionCostSummary(transcript, FIXTURE_PRICES)).toMatchObject({ hasUnknown: false, allClaude: true });
    });

    it('ignores synthetic and zero-usage messages', () => {
        write([
            assistantLine('a', '<synthetic>', { input: MILLION }),
            assistantLine('b', 'mystery-model', {}),
            assistantLine('c', 'k3-256k', { input: MILLION })
        ]);

        expect(getSessionCostSummary(transcript, FIXTURE_PRICES)).toMatchObject({ hasUnknown: false });
        expect(total()).toBeCloseTo(1, 6);
    });

    it('counts only appended lines on a later render and resets when the file shrinks', () => {
        write([assistantLine('a', 'k3-256k', { input: MILLION })]);
        expect(total()).toBeCloseTo(1, 6);

        append([assistantLine('b', 'k3-256k', { input: MILLION })]);
        expect(total()).toBeCloseTo(2, 6);

        write([assistantLine('c', 'glm-5.3', { input: MILLION })]);
        expect(total()).toBeCloseTo(2, 6);
    });

    it('waits for a trailing line that has no newline yet', () => {
        write([assistantLine('a', 'k3-256k', { input: MILLION })]);
        const partial = assistantLine('b', 'k3-256k', { input: MILLION });
        fs.appendFileSync(transcript, partial.slice(0, 20), 'utf-8');
        expect(total()).toBeCloseTo(1, 6);

        fs.appendFileSync(transcript, `${partial.slice(20)}\n`, 'utf-8');
        expect(total()).toBeCloseTo(2, 6);
    });

    it('reprices from scratch when the price table changes', () => {
        write([assistantLine('a', 'k3-256k', { input: MILLION })]);
        expect(total()).toBeCloseTo(1, 6);

        const doubled: ModelPrices = { 'moonshotai/kimi-k3': { input: 2, output: 10 } };
        expect(getSessionCostSummary(transcript, doubled)?.total).toBeCloseTo(2, 6);
    });

    it('reports nothing when the transcript is unreadable', () => {
        expect(total()).toBeUndefined();
    });
});

describe('session cost widget', () => {
    let tempDir: string;
    let transcript: string;

    function render(totalCostUsd: number, transcriptPath: string | undefined = transcript): string | null {
        return new SessionCostWidget().render(
            { id: 'cost', type: 'session-cost', rawValue: true },
            { data: { transcript_path: transcriptPath, cost: { total_cost_usd: totalCostUsd } } },
            DEFAULT_SETTINGS
        );
    }

    function write(lines: string[]): void {
        fs.writeFileSync(transcript, `${lines.join('\n')}\n`, 'utf-8');
    }

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-session-cost-widget-'));
        vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
        seedFreshPriceCache(tempDir);
        transcript = path.join(tempDir, 'sess.jsonl');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('shows the computed cost for a session with non-Claude models', () => {
        write([
            assistantLine('a', 'k3-256k', { input: MILLION }),
            assistantLine('b', 'k3-256k', { output: MILLION })
        ]);

        const price = (modelPrices as ModelPrices)['moonshotai/kimi-k3'];
        expect(price).toBeDefined();
        expect(render(99)).toBe(`$${((price?.input ?? 0) + (price?.output ?? 0)).toFixed(2)}`);
    });

    it('shows the reported cost with ~ when a model has no known price', () => {
        write([
            assistantLine('a', 'k3-256k', { input: MILLION }),
            assistantLine('b', 'mystery-model', { input: MILLION })
        ]);

        expect(render(7.5)).toBe('$7.50~');
    });

    it('keeps the reported cost for an all-Claude session', () => {
        write([assistantLine('a', 'claude-opus-5-5', { input: MILLION })]);

        expect(render(7.5)).toBe('$7.50');
    });

    it('keeps the reported cost when the transcript is unreadable or not given', () => {
        expect(render(2.5)).toBe('$2.50');
        expect(render(2.5, undefined)).toBe('$2.50');
    });
});

describe('session cost record', () => {
    const close = (n: number) => expect.closeTo(n, 6) as number;

    let tempDir: string;
    let transcript: string;
    let sessionDir: string;
    let agentsDir: string;

    const costPath = () => path.join(sessionDir, 'cost.json');
    const agentCostPath = (id: string) => path.join(agentsDir, `agent-${id}.cost.json`);
    const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;

    function write(file: string, lines: string[]): void {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf-8');
    }

    function tmpFiles(): string[] {
        return fs.readdirSync(tempDir, { recursive: true, encoding: 'utf-8' }).filter(name => name.endsWith('.tmp'));
    }

    function resolve(claudeCodeTotal = 99, transcriptPath: string | undefined = transcript) {
        return resolveSessionCost(transcriptPath, claudeCodeTotal, FIXTURE_PRICES);
    }

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-session-cost-record-'));
        vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
        seedFreshPriceCache(tempDir);
        transcript = path.join(tempDir, 'proj', 'sess.jsonl');
        sessionDir = path.join(tempDir, 'proj', 'sess');
        agentsDir = path.join(sessionDir, 'subagents');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function writeMixedSession(): void {
        write(transcript, [
            assistantLine('a', 'k3-256k', { input: MILLION, output: 100_000, cacheRead: MILLION }),
            assistantLine('b', 'glm-5.3', { input: MILLION })
        ]);
        write(path.join(agentsDir, 'agent-aaa.jsonl'), [assistantLine('c', 'k3-256k', { input: MILLION })]);
        write(path.join(agentsDir, 'agent-bbb.jsonl'), [assistantLine('d', 'glm-5.3', { output: MILLION })]);
    }

    it('records the per-model session total and each subagent for a mixed-model session', () => {
        writeMixedSession();

        expect(resolve().totalUsd).toBeCloseTo(1 + 1 + 0.5 + 2 + 1 + 4, 6);

        const session = readJson(costPath());
        expect(session.sessionId).toBe('sess');
        expect(session.source).toBe('computed');
        expect(session.approximate).toBe(false);
        expect(session.totalUsd).toBeCloseTo(9.5, 6);
        expect(session.byModel).toMatchObject({
            'k3-256k': { usd: close(3.5), inputTokens: 2 * MILLION, outputTokens: 100_000, cacheReadTokens: MILLION },
            'glm-5.3': { usd: close(6), inputTokens: MILLION, outputTokens: MILLION }
        });
        expect(session).not.toHaveProperty('subagents');

        expect(readJson(agentCostPath('aaa'))).toMatchObject({
            agentId: 'aaa',
            totalUsd: close(1),
            approximate: false,
            byModel: { 'k3-256k': { inputTokens: MILLION } }
        });
        expect(readJson(agentCostPath('bbb')).totalUsd).toBeCloseTo(4, 6);
    });

    it('records the Claude Code total for an all-Claude session', () => {
        write(transcript, [assistantLine('a', 'claude-sonnet-5-5', { input: MILLION })]);

        expect(resolve(7.5).totalUsd).toBe(7.5);
        expect(readJson(costPath())).toMatchObject({ totalUsd: 7.5, source: 'claude-code', approximate: false });
    });

    it('marks the record approximate when a model has no known price', () => {
        write(transcript, [
            assistantLine('a', 'k3-256k', { input: MILLION }),
            assistantLine('b', 'mystery-model', { input: MILLION })
        ]);
        write(path.join(agentsDir, 'agent-aaa.jsonl'), [assistantLine('c', 'mystery-model', { input: MILLION })]);

        expect(resolve(7.5)).toMatchObject({ totalUsd: 7.5, approximate: true });
        expect(readJson(costPath())).toMatchObject({
            totalUsd: 7.5,
            source: 'claude-code',
            approximate: true,
            byModel: { 'mystery-model': { usd: null }, 'k3-256k': { usd: close(1) } }
        });
        expect(readJson(agentCostPath('aaa'))).toMatchObject({ totalUsd: 0, approximate: true });
    });

    it('leaves every file untouched when nothing changed', () => {
        writeMixedSession();
        resolve();
        const files = [costPath(), agentCostPath('aaa'), agentCostPath('bbb')];
        const old = new Date(Date.now() - 60_000);
        for (const file of files) {
            fs.utimesSync(file, old, old);
        }
        const before = files.map(file => fs.readFileSync(file, 'utf-8'));

        resolve();

        expect(files.map(file => fs.readFileSync(file, 'utf-8'))).toEqual(before);
        for (const file of files) {
            expect(fs.statSync(file).mtimeMs).toBe(old.getTime());
        }
    });

    it('rewrites the session and only the subagent that gained lines', () => {
        writeMixedSession();
        resolve();
        const old = new Date(Date.now() - 60_000);
        for (const file of [costPath(), agentCostPath('aaa'), agentCostPath('bbb')]) {
            fs.utimesSync(file, old, old);
        }

        fs.appendFileSync(path.join(agentsDir, 'agent-aaa.jsonl'), `${assistantLine('e', 'k3-256k', { input: MILLION })}\n`);
        resolve();

        expect(readJson(costPath()).totalUsd).toBeCloseTo(10.5, 6);
        expect(readJson(agentCostPath('aaa')).totalUsd).toBeCloseTo(2, 6);
        expect(fs.statSync(agentCostPath('bbb')).mtimeMs).toBe(old.getTime());
    });

    it('restores a deleted record on the next render', () => {
        writeMixedSession();
        resolve();
        fs.rmSync(costPath());

        resolve();

        expect(readJson(costPath()).totalUsd).toBeCloseTo(9.5, 6);
    });

    it('still returns the cost when the record cannot be written', () => {
        write(transcript, [assistantLine('a', 'k3-256k', { input: MILLION })]);
        // A file where the session directory belongs makes every write fail
        fs.writeFileSync(sessionDir, 'in the way', 'utf-8');

        expect(resolve().totalUsd).toBeCloseTo(1, 6);
        expect(fs.readFileSync(sessionDir, 'utf-8')).toBe('in the way');
        expect(tmpFiles()).toEqual([]);
    });

    it('leaves no tmp file behind when the target path is a directory', () => {
        write(transcript, [assistantLine('a', 'k3-256k', { input: MILLION })]);
        fs.mkdirSync(costPath(), { recursive: true });

        expect(resolve().totalUsd).toBeCloseTo(1, 6);
        expect(resolve().totalUsd).toBeCloseTo(1, 6);
        expect(fs.statSync(costPath()).isDirectory()).toBe(true);
        expect(tmpFiles()).toEqual([]);
    });

    it('writes nothing without a transcript path or for a transcript that does not exist', () => {
        expect(resolve(3, undefined)).toMatchObject({ totalUsd: 3, approximate: false });
        expect(resolve(3)).toMatchObject({ totalUsd: 3 });
        expect(fs.existsSync(sessionDir)).toBe(false);
    });

    it('writes nothing in preview mode', () => {
        write(transcript, [assistantLine('a', 'k3-256k', { input: MILLION })]);

        new SessionCostWidget().render(
            { id: 'cost', type: 'session-cost' },
            { isPreview: true, data: { transcript_path: transcript } },
            DEFAULT_SETTINGS
        );

        expect(fs.existsSync(sessionDir)).toBe(false);
    });
});
