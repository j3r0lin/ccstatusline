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

import type {
    RenderContext,
    WidgetItem
} from '../../types';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import { LastPromptWidget } from '../LastPrompt';

const DIM_ON = '\x1b[2m';
const DIM_OFF = '\x1b[22m';
const ITEM: WidgetItem = { id: 'lp', type: 'last-prompt' };

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-prompt-widget-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTranscript(name: string, lines: unknown[]): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    return p;
}

function render(context: RenderContext): string | null {
    return new LastPromptWidget().render(ITEM, context, DEFAULT_SETTINGS);
}

describe('LastPromptWidget', () => {
    it('renders the last user prompt from the transcript path', () => {
        const transcript = writeTranscript('a.jsonl', [
            { type: 'user', message: { role: 'user', content: 'hello world' } }
        ]);

        expect(render({ data: { transcript_path: transcript } })).toBe(`${DIM_ON}❯ hello world${DIM_OFF}`);
    });

    it('shows a placeholder example in preview mode', () => {
        expect(render({ isPreview: true })).toBe(`${DIM_ON}❯ What does this function do?${DIM_OFF}`);
    });

    it('returns null when no transcript path is provided', () => {
        expect(render({ data: {} })).toBeNull();
    });

    it('collapses multi-line prompts into a single line', () => {
        const transcript = writeTranscript('b.jsonl', [
            { type: 'user', message: { role: 'user', content: 'line one\nline two\nline three' } }
        ]);

        expect(render({ data: { transcript_path: transcript } })).toBe(`${DIM_ON}❯ line one line two line three${DIM_OFF}`);
    });

    it('returns null when the transcript exists but has no plain-string user message', () => {
        const transcript = writeTranscript('c.jsonl', [
            { type: 'assistant', message: { role: 'assistant', content: 'hi' } }
        ]);

        expect(render({ data: { transcript_path: transcript } })).toBeNull();
    });
});
