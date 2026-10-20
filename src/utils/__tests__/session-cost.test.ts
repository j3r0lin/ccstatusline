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
import { getSessionCostSummary } from '../session-cost';

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
