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

import { formatModelName } from '../model-names';

import { MODEL_NAMES_FIXTURE } from './model-names-fixture';

describe('formatModelName', () => {
    let dir: string;
    let file: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-names-'));
        file = path.join(dir, 'model-names.json');
        fs.writeFileSync(file, JSON.stringify(MODEL_NAMES_FIXTURE));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it.each([
        ['claude-opus-5-5', 'Opus 5.5'],
        ['claude-opus-5-5-20260101[1m]', 'Opus 5.5'],
        ['claude-fable-5', 'Fable 5'],
        ['gpt-6.1-sol', 'Sol 6.1'],
        ['openai/gpt-6.1-sol', 'Sol 6.1'],
        ['kimi-for-coding-highspeed', 'K2 Fast'],
        ['k3-256k', 'K3'],
        ['grok-4.7-build-fast', 'Grok 4.7 Fast'],
        ['deepseek-v4.1-flash-free', 'DSF 4.1 Free'],
        ['glm-5.3-flash-free', 'glm-5.3-flash-free'],
        ['unknown-model', 'unknown-model']
    ])('names %s as %s', (id, expected) => {
        expect(formatModelName(id, file)).toBe(expected);
    });

    it('places the name inside a suffix label holding {name}', () => {
        fs.writeFileSync(file, JSON.stringify({ ...MODEL_NAMES_FIXTURE, suffixes: { '-free': '🎁 {name}' } }));
        expect(formatModelName('deepseek-v4.1-flash-free', file)).toBe('🎁 DSF 4.1');
        expect(formatModelName('glm-5.3-flash-free', file)).toBe('glm-5.3-flash-free');
    });

    it('only cleans the id when the table file is missing', () => {
        const missing = path.join(dir, 'absent.json');
        expect(formatModelName('anthropic/claude-opus-5-5-20260101[1m]', missing)).toBe('claude-opus-5-5');
    });

    it('only cleans the id when the table file is not valid JSON', () => {
        fs.writeFileSync(file, '{ not json');
        expect(formatModelName('deepseek-v4.1-flash-free', file)).toBe('deepseek-v4.1-flash-free');
    });
});
