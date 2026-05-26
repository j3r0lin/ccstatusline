import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import { readLastPromptFromTranscript } from '../last-prompt';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-prompt-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(name: string, lines: unknown[]): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    return p;
}

describe('readLastPromptFromTranscript', () => {
    it('returns the latest plain-string user message', () => {
        const transcript = writeJsonl('a.jsonl', [
            { type: 'user', message: { role: 'user', content: 'first message' } },
            { type: 'assistant', message: { role: 'assistant', content: 'hi' } },
            { type: 'user', message: { role: 'user', content: 'second message' } }
        ]);

        expect(readLastPromptFromTranscript(transcript)).toBe('second message');
    });

    it('returns null when the transcript file does not exist', () => {
        expect(readLastPromptFromTranscript(path.join(tmpDir, 'missing.jsonl'))).toBeNull();
    });

    it('handles transcripts larger than the chunk read window', () => {
        const lines: unknown[] = [];
        const filler = 'x'.repeat(2048);
        for (let i = 0; i < 50; i++) {
            lines.push({
                type: 'user',
                message: {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 't', content: filler }]
                }
            });
        }
        lines.push({ type: 'user', message: { role: 'user', content: 'expected-tail' } });
        for (let i = 0; i < 50; i++) {
            lines.push({
                type: 'user',
                message: {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 't', content: filler }]
                }
            });
        }
        const transcript = writeJsonl('big.jsonl', lines);
        // sanity: file must straddle multiple chunks of the backward reader
        expect(fs.statSync(transcript).size).toBeGreaterThan(64 * 1024);

        expect(readLastPromptFromTranscript(transcript)).toBe('expected-tail');
    });

    it('preserves multi-byte UTF-8 chars that straddle chunk boundaries', () => {
        // Build a transcript where the 64 KB read window splits mid-character
        // inside the user line's Chinese run. Layout:
        //   [user line: header + filler + 中×N + filler + footer] \n [tool_result padding]
        // We size the padding so that (filesize - 65536) falls inside the 中×N region.
        const header = '{"type":"user","message":{"role":"user","content":"';
        const footer = '"}}';
        const filler = 'x'.repeat(500);
        const content = filler + '中'.repeat(200) + filler;
        const userLine = header + content + footer;
        const userLineBytes = Buffer.byteLength(userLine + '\n', 'utf-8');
        const chineseStartByte = Buffer.byteLength(header + filler, 'utf-8');
        // Want filesize - 65536 to land strictly inside a 中 character (not on its 1st byte),
        // so the boundary splits a multi-byte sequence.
        const targetBoundary = chineseStartByte + 100 * 3 + 1; // middle of run, +1 byte into a char
        const targetFileSize = targetBoundary + 65536;
        const paddingBytes = targetFileSize - userLineBytes;

        const toolLine = JSON.stringify({
            type: 'user',
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 't', content: 'y' }]
            }
        }) + '\n';
        const toolLineBytes = Buffer.byteLength(toolLine, 'utf-8');
        const padding = toolLine.repeat(Math.ceil(paddingBytes / toolLineBytes));

        const p = path.join(tmpDir, 'utf8.jsonl');
        fs.writeFileSync(p, userLine + '\n' + padding);
        expect(fs.statSync(p).size).toBeGreaterThan(64 * 1024);

        expect(readLastPromptFromTranscript(p)).toBe(content);
    });

    it('skips corrupted JSON lines without throwing', () => {
        const p = path.join(tmpDir, 'd.jsonl');
        const good = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } });
        fs.writeFileSync(p, good + '\nnot-json-{{\n');

        expect(readLastPromptFromTranscript(p)).toBe('hello');
    });

    it('returns null when no plain-string user message exists', () => {
        const transcript = writeJsonl('c.jsonl', [
            { type: 'assistant', message: { role: 'assistant', content: 'hi' } },
            {
                type: 'user',
                message: {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'x', content: 'output' }]
                }
            }
        ]);

        expect(readLastPromptFromTranscript(transcript)).toBeNull();
    });

    it('skips tool_result entries injected as user-role messages', () => {
        const transcript = writeJsonl('b.jsonl', [
            { type: 'user', message: { role: 'user', content: 'real prompt' } },
            { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
            {
                type: 'user',
                message: {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'x', content: 'output' }]
                }
            }
        ]);

        expect(readLastPromptFromTranscript(transcript)).toBe('real prompt');
    });
});
