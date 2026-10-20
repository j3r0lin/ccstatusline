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

import { DEFAULT_SETTINGS } from '../../types/Settings';
import { SessionCostWidget } from '../../widgets/SessionCost';

interface Usage {
    input?: number;
    output?: number;
    cacheRead?: number;
    write5m?: number;
    write1h?: number;
    /** Omit the 5m/1h breakdown and report only the combined count */
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

describe('session cost at per-model API prices', () => {
    let tempDir: string;
    let transcript: string;

    function render(totalCostUsd = 99): string | null {
        return new SessionCostWidget().render(
            { id: 'cost', type: 'session-cost', rawValue: true },
            { data: { transcript_path: transcript, cost: { total_cost_usd: totalCostUsd } } },
            DEFAULT_SETTINGS
        );
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
        // kimi-k3: $3 in, $15 out; glm-5.3: $1.4 in, $4.4 out
        write([
            assistantLine('a', 'k3-256k', { input: 1_000_000, output: 100_000 }),
            assistantLine('b', 'glm-5.3', { input: 1_000_000, output: 1_000_000 })
        ]);

        expect(render()).toBe('$10.30');
    });

    it('counts a message once however many lines carry its id', () => {
        const line = assistantLine('a', 'k3-256k', { input: 1_000_000 });
        write([line, line, line]);

        expect(render()).toBe('$3.00');
    });

    it('includes subagent transcripts', () => {
        write([assistantLine('a', 'k3-256k', { input: 1_000_000 })]);
        const subagents = path.join(tempDir, 'sess', 'subagents');
        fs.mkdirSync(subagents, { recursive: true });
        fs.writeFileSync(
            path.join(subagents, 'agent-1.jsonl'),
            `${assistantLine('s1', 'glm-5.3', { input: 1_000_000 })}\n`,
            'utf-8'
        );
        fs.writeFileSync(path.join(subagents, 'agent-1.meta.json'), '{"input_tokens":5}', 'utf-8');

        expect(render()).toBe('$4.40');
    });

    it('prices 5m cache writes at the cache write price and 1h writes at twice the input price', () => {
        // claude-sonnet-5-5: $2 in, $2.5 cache write; mixed with k3 so the sum is computed
        write([
            assistantLine('a', 'k3-256k', { input: 1 }),
            assistantLine('b', 'claude-sonnet-5-5', { write5m: 1_000_000 }),
            assistantLine('c', 'claude-sonnet-5-5', { write1h: 1_000_000 })
        ]);

        expect(render()).toBe('$6.50');
    });

    it('treats a combined cache creation count without a breakdown as 5m writes', () => {
        write([
            assistantLine('a', 'k3-256k', { combinedWrite: 1_000_000 })
        ]);

        // kimi-k3 cache write price is $3
        expect(render()).toBe('$3.00');
    });

    it('switches to the higher price tier when the prompt exceeds the tier size', () => {
        // grok-4.7: $2 in below 200k prompt tokens, $4 above
        write([
            assistantLine('a', 'grok-4.7', { input: 100_000 }),
            assistantLine('b', 'grok-4.7', { input: 250_000 })
        ]);

        expect(render()).toBe('$1.20');
    });

    it('falls back to the reported cost with ~ when a model has no known price', () => {
        write([
            assistantLine('a', 'k3-256k', { input: 1_000_000 }),
            assistantLine('b', 'mystery-model', { input: 1_000_000 })
        ]);

        expect(render(7.5)).toBe('$7.50~');
    });

    it('keeps the reported cost for an all-Claude session', () => {
        write([assistantLine('a', 'claude-opus-5-5', { input: 1_000_000 })]);

        expect(render(7.5)).toBe('$7.50');
    });

    it('ignores synthetic and zero-usage messages', () => {
        write([
            assistantLine('a', '<synthetic>', { input: 1_000_000 }),
            assistantLine('b', 'mystery-model', {}),
            assistantLine('c', 'k3-256k', { input: 1_000_000 })
        ]);

        expect(render()).toBe('$3.00');
    });

    it('counts only appended lines on a later render and resets when the file shrinks', () => {
        write([assistantLine('a', 'k3-256k', { input: 1_000_000 })]);
        expect(render()).toBe('$3.00');

        append([assistantLine('b', 'k3-256k', { input: 1_000_000 })]);
        expect(render()).toBe('$6.00');

        write([assistantLine('c', 'glm-5.3', { input: 1_000_000 })]);
        expect(render()).toBe('$1.40');
    });

    it('waits for a trailing line that has no newline yet', () => {
        write([assistantLine('a', 'k3-256k', { input: 1_000_000 })]);
        const partial = assistantLine('b', 'k3-256k', { input: 1_000_000 });
        fs.appendFileSync(transcript, partial.slice(0, 20), 'utf-8');
        expect(render()).toBe('$3.00');

        fs.appendFileSync(transcript, `${partial.slice(20)}\n`, 'utf-8');
        expect(render()).toBe('$6.00');
    });

    it('keeps the reported cost when the transcript is unreadable', () => {
        expect(render(2.5)).toBe('$2.50');
    });
});
