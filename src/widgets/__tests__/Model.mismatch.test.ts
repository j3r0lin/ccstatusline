import chalk from 'chalk';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { RenderContext } from '../../types';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import { stripSgrCodes } from '../../utils/ansi';
import { ModelWidget } from '../Model';

const magpie = vi.hoisted(() => ({ model: undefined as string | undefined }));
vi.mock('../../utils/magpie-account-label', () => ({
    resolveMagpieAccountLabel: () => null,
    resolveMagpieModel: () => magpie.model
}));

const RAW = { id: 'model', type: 'model', rawValue: true } as const;
const dirs: string[] = [];

function transcript(lines: object[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-mismatch-'));
    dirs.push(dir);
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    return file;
}

function assistant(model: string, extra: object = {}): object {
    return { type: 'assistant', message: { model }, ...extra };
}

function modelAttachment(modelId: string): object {
    return { type: 'attachment', attachment: { type: 'model', identity: { modelId } } };
}

function ctx(id: string, lines: object[]): RenderContext {
    return { data: { model: { id }, transcript_path: transcript(lines) } };
}

function render(context: RenderContext, colorLevel: 0 | 1 | 2 | 3 = 0): string {
    return new ModelWidget().render(RAW, context, { ...DEFAULT_SETTINGS, colorLevel }) ?? '';
}

describe('ModelWidget model mismatch marker', () => {
    let level: typeof chalk.level;
    beforeAll(() => {
        level = chalk.level;
        chalk.level = 3;
    });
    afterAll(() => {
        chalk.level = level;
    });
    afterEach(() => {
        magpie.model = undefined;
        for (const d of dirs.splice(0)) {
            fs.rmSync(d, { recursive: true, force: true });
        }
    });

    it('marks the returned model when it differs from the requested one', () => {
        expect(render(ctx('claude-opus-5-5', [assistant('claude-sonnet-5-5')]))).toContain('→ Sonnet 5.5');
    });

    it('shows no marker when returned and requested match, ignoring suffix and date', () => {
        expect(render(ctx('claude-opus-5-5[1m]', [assistant('claude-opus-5-5')]))).not.toContain('→');
        expect(render(ctx('claude-sonnet-4-5-20250929', [assistant('claude-sonnet-4-5')]))).not.toContain('→');
    });

    it('names the model magpie recorded instead of the routing group name', () => {
        magpie.model = 'claude-sonnet-5-5';
        const out = render(ctx('auto-sonnet', [assistant('claude-sonnet-5-5')]));
        expect(out).toContain('Sonnet 5.5');
        expect(out).not.toContain('auto-sonnet');
        expect(out).not.toContain('→');
    });

    it('marks the returned model when it differs from the one magpie recorded', () => {
        magpie.model = 'claude-sonnet-5-5';
        const out = render(ctx('auto-sonnet', [assistant('claude-opus-5-5')]));
        expect(out).toContain('Sonnet 5.5');
        expect(out).toContain('→ Opus 5.5');
    });

    it('keeps the group name until magpie has recorded a model', () => {
        expect(render(ctx('auto-sonnet', []))).toContain('auto-sonnet');
    });

    it('shows no marker right after a model switch, before a request goes out under the new model', () => {
        const lines = [modelAttachment('claude-opus-5-5'), assistant('claude-sonnet-5-5')];
        expect(render(ctx('claude-sonnet-5-5', lines))).not.toContain('→');
        expect(render(ctx('claude-haiku-5-5', lines))).not.toContain('→');
    });

    it('marks a mismatch once the last request was made under the displayed model', () => {
        const lines = [modelAttachment('claude-opus-5-5'), assistant('claude-sonnet-5-5')];
        expect(render(ctx('claude-opus-5-5', lines))).toContain('→ Sonnet 5.5');
    });

    it('treats a group/ prefixed status id as the group the attachment names', () => {
        magpie.model = 'claude-sonnet-5-5';
        const lines = [modelAttachment('auto-sonnet'), assistant('claude-opus-5-5')];
        expect(render(ctx('group/auto-sonnet', lines))).toContain('→ Opus 5.5');
    });

    it('shows no marker for non-Claude requests', () => {
        expect(render(ctx('grok-4.5', [assistant('claude-sonnet-5-5')]))).not.toContain('→');
    });

    it('ignores sidechain and synthetic messages, using the latest main-thread one', () => {
        const lines = [
            assistant('claude-sonnet-5-5'),
            assistant('claude-opus-5-5'),
            assistant('claude-haiku-5-5', { isSidechain: true }),
            assistant('<synthetic>')
        ];
        expect(render(ctx('claude-opus-5-5', lines))).not.toContain('→');
    });

    it('drops the marker once the session returns to the requested model', () => {
        const lines = [assistant('claude-sonnet-5-5'), assistant('claude-opus-5-5')];
        expect(render(ctx('claude-opus-5-5', lines))).not.toContain('→');
    });

    it('does not crash on a missing transcript', () => {
        expect(render({ data: { model: { id: 'claude-opus-5-5' }, transcript_path: '/nonexistent/x.jsonl' } })).not.toContain('→');
    });

    it('colors the marker when colors are on and keeps fast mode', () => {
        const context = ctx('claude-opus-5-5', [assistant('claude-sonnet-5-5')]);
        context.data = { ...context.data, fast_mode: true };
        const out = render(context, 3);
        expect(out).toMatch(/\x1b\[[0-9;]*m→ Sonnet 5\.5/);
        expect(stripSgrCodes(out)).toMatch(/↯ → Sonnet 5\.5$/);
    });
});
