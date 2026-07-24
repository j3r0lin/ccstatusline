import * as fs from 'fs';
import os from 'os';
import path from 'path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import { getTokenMetrics } from '../jsonl';
import {
    clearTranscriptMemo,
    isTranscriptTurnInFlight,
    readTranscriptData,
    type SlimTranscriptEntry
} from '../transcript-cache';

function makeUsageLine(params: {
    timestamp: string;
    input: number;
    output: number;
    stopReason?: string | null;
}): string {
    return JSON.stringify({
        timestamp: params.timestamp,
        message: {
            stop_reason: params.stopReason ?? 'end_turn',
            usage: {
                input_tokens: params.input,
                output_tokens: params.output
            }
        }
    });
}

describe('transcript incremental cache', () => {
    const tempRoots: string[] = [];

    beforeEach(() => {
        clearTranscriptMemo();
    });

    afterEach(() => {
        while (tempRoots.length > 0) {
            const root = tempRoots.pop();
            if (root) {
                fs.rmSync(root, { recursive: true, force: true });
            }
        }
    });

    function makeTranscriptPath(): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-transcript-cache-'));
        tempRoots.push(root);
        return path.join(root, 'session.jsonl');
    }

    it('reflects appended lines on subsequent reads', async () => {
        const transcriptPath = makeTranscriptPath();
        fs.writeFileSync(transcriptPath, `${makeUsageLine({ timestamp: '2026-01-01T10:00:00.000Z', input: 100, output: 50 })}\n`);

        const first = await getTokenMetrics(transcriptPath);
        expect(first.inputTokens).toBe(100);
        expect(first.outputTokens).toBe(50);

        clearTranscriptMemo();
        fs.appendFileSync(transcriptPath, `${makeUsageLine({ timestamp: '2026-01-01T10:01:00.000Z', input: 200, output: 80 })}\n`);

        const second = await getTokenMetrics(transcriptPath);
        expect(second.inputTokens).toBe(300);
        expect(second.outputTokens).toBe(130);
    });

    it('handles trailing lines without a final newline', async () => {
        const transcriptPath = makeTranscriptPath();
        fs.writeFileSync(transcriptPath, [
            makeUsageLine({ timestamp: '2026-01-01T10:00:00.000Z', input: 10, output: 5 }),
            makeUsageLine({ timestamp: '2026-01-01T10:01:00.000Z', input: 20, output: 8 })
        ].join('\n'));

        const first = await getTokenMetrics(transcriptPath);
        expect(first.inputTokens).toBe(30);

        // The unterminated tail line must not be skipped or double counted
        // once it gets terminated and more content is appended.
        clearTranscriptMemo();
        fs.appendFileSync(transcriptPath, `\n${makeUsageLine({ timestamp: '2026-01-01T10:02:00.000Z', input: 40, output: 2 })}\n`);

        const second = await getTokenMetrics(transcriptPath);
        expect(second.inputTokens).toBe(70);
        expect(second.outputTokens).toBe(15);
    });

    it('tracks the last plain user prompt across incremental appends', async () => {
        const transcriptPath = makeTranscriptPath();
        const userLine = (ts: string, content: string) => JSON.stringify({
            timestamp: ts,
            type: 'user',
            message: { content }
        });
        fs.writeFileSync(transcriptPath, `${userLine('2026-01-01T10:00:00.000Z', 'first prompt')}\n`);

        const first = await readTranscriptData(transcriptPath);
        expect(first.lastPrompt).toBe('first prompt');

        clearTranscriptMemo();
        fs.appendFileSync(transcriptPath, `${userLine('2026-01-01T10:01:00.000Z', 'second prompt')}\n`);

        const second = await readTranscriptData(transcriptPath);
        expect(second.lastPrompt).toBe('second prompt');

        // Appending non-prompt lines keeps the cached prompt.
        clearTranscriptMemo();
        fs.appendFileSync(transcriptPath, `${JSON.stringify({ timestamp: '2026-01-01T10:02:00.000Z', type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 2 } } })}\n`);

        const third = await readTranscriptData(transcriptPath);
        expect(third.lastPrompt).toBe('second prompt');
    });

    it('recomputes from scratch when the file is rewritten with different content', async () => {
        const transcriptPath = makeTranscriptPath();
        fs.writeFileSync(transcriptPath, `${makeUsageLine({ timestamp: '2026-01-01T10:00:00.000Z', input: 100, output: 50 })}\n`);

        const first = await getTokenMetrics(transcriptPath);
        expect(first.inputTokens).toBe(100);

        clearTranscriptMemo();
        const rewritten = [
            makeUsageLine({ timestamp: '2026-02-02T10:00:00.000Z', input: 7, output: 3 }),
            makeUsageLine({ timestamp: '2026-02-02T10:01:00.000Z', input: 9, output: 1 })
        ].join('\n');
        fs.writeFileSync(transcriptPath, `${rewritten}\n`);

        const second = await getTokenMetrics(transcriptPath);
        expect(second.inputTokens).toBe(16);
        expect(second.outputTokens).toBe(4);
    });
});

describe('isTranscriptTurnInFlight', () => {
    it('returns false for an empty transcript', () => {
        expect(isTranscriptTurnInFlight([])).toBe(false);
    });

    it('returns true when the newest main-chain row is a user turn', () => {
        const entries: SlimTranscriptEntry[] = [
            { y: 'assistant', t: 1 },
            { y: 'user', t: 2 }
        ];
        expect(isTranscriptTurnInFlight(entries)).toBe(true);
    });

    it('returns false when the newest main-chain row is an assistant turn', () => {
        const entries: SlimTranscriptEntry[] = [
            { y: 'user', t: 1 },
            { y: 'assistant', t: 2 }
        ];
        expect(isTranscriptTurnInFlight(entries)).toBe(false);
    });

    it('skips sidechain rows when deciding turn state', () => {
        const entries: SlimTranscriptEntry[] = [
            { y: 'user', t: 1 },
            { y: 'assistant', t: 2 },
            { y: 'user', t: 3, s: 1 }
        ];
        expect(isTranscriptTurnInFlight(entries)).toBe(false);
    });

    it('treats a trailing tool-result user row as in flight', () => {
        const entries: SlimTranscriptEntry[] = [
            { y: 'assistant', t: 1 },
            { y: 'user', t: 2 },
            { y: 'assistant', t: 3 },
            { y: 'user', t: 4 }
        ];
        expect(isTranscriptTurnInFlight(entries)).toBe(true);
    });
});
