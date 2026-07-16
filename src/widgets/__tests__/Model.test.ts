import chalk from 'chalk';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it
} from 'vitest';

import type {
    RenderContext,
    WidgetItem
} from '../../types';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import { stripSgrCodes } from '../../utils/ansi';
import { ModelWidget } from '../Model';

const ITEM: WidgetItem = { id: 'model', type: 'model' };
const RAW_ITEM: WidgetItem = { id: 'model', type: 'model', rawValue: true };

function makeContext(overrides: Partial<RenderContext> = {}): RenderContext {
    return { ...overrides };
}

// Distinct SGR color-set sequences (excludes the reset) present in `text`.
function colorCodes(text: string): string[] {
    return [...new Set(text.match(/\x1b\[[0-9;]*m/g) ?? [])].filter(c => c !== '\x1b[0m');
}

function modelContext(effortLevel?: string | null): RenderContext {
    return makeContext({
        data: {
            model: { id: 'claude-opus-4-6[1m]', display_name: 'Opus 4.6 (1M context)' },
            ...(effortLevel !== undefined ? { effort: { level: effortLevel } } : {})
        }
    });
}

const EFFORT_RAW: WidgetItem = { id: 'model', type: 'model', rawValue: true, metadata: { effortColor: 'true' } };

describe('ModelWidget', () => {
    // Runtime forces truecolor globally (ccstatusline.ts / tui.tsx); mirror that
    // here so getColorAnsiCode emits SGR codes for named colors.
    let originalChalkLevel: typeof chalk.level;
    beforeAll(() => {
        originalChalkLevel = chalk.level;
        chalk.level = 3;
    });
    afterAll(() => {
        chalk.level = originalChalkLevel;
    });

    describe('render()', () => {
        it('strips parenthetical suffix from display_name', () => {
            const ctx = makeContext({ data: { model: { id: 'claude-opus-4-6[1m]', display_name: 'Opus 4.6 (1M context)' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Opus 4.6');
        });

        it('strips parenthetical from Sonnet display_name', () => {
            const ctx = makeContext({ data: { model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6 (200K context)' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Sonnet 4.6');
        });

        it('leaves name unchanged when no parenthetical', () => {
            const ctx = makeContext({ data: { model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Sonnet 4.6');
        });

        it('handles model as string (legacy)', () => {
            const ctx = makeContext({ data: { model: 'Claude Opus 4.6 (1M context)' } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Opus 4.6');
        });

        it('renders Kimi models as "Kimi" from id', () => {
            const ctx = makeContext({ data: { model: { id: 'kimi-k2-0711-longcontext' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Kimi');
        });

        it('renders Kimi models as "Kimi" from display_name', () => {
            const ctx = makeContext({ data: { model: { id: 'kimi-k2', display_name: 'Kimi K2' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Kimi');
        });

        it('renders kimi-for-coding-highspeed as "Kimi Fast"', () => {
            const ctx = makeContext({ data: { model: { id: 'kimi-for-coding-highspeed' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Kimi Fast');
        });

        it('renders kimi-for-coding-highspeed display_name as "Kimi Fast"', () => {
            const ctx = makeContext({ data: { model: { id: 'kimi-for-coding-highspeed', display_name: 'Kimi for Coding Highspeed' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Kimi Fast');
        });

        it('includes Model: prefix when rawValue is false', () => {
            const ctx = makeContext({ data: { model: { id: 'claude-opus-4-6[1m]', display_name: 'Opus 4.6 (1M context)' } } });
            expect(new ModelWidget().render(ITEM, ctx, DEFAULT_SETTINGS)).toBe('Model: Opus 4.6');
        });

        it('returns null when model is absent', () => {
            const ctx = makeContext({ data: {} });
            expect(new ModelWidget().render(ITEM, ctx, DEFAULT_SETTINGS)).toBeNull();
        });

        it('returns null when context.data is absent', () => {
            const ctx = makeContext();
            expect(new ModelWidget().render(ITEM, ctx, DEFAULT_SETTINGS)).toBeNull();
        });

        it('returns preview text in preview mode', () => {
            const ctx = makeContext({ isPreview: true });
            expect(new ModelWidget().render(ITEM, ctx, DEFAULT_SETTINGS)).toBe('Model: Claude');
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Claude');
        });

        it('falls back to model id when display_name is absent', () => {
            const ctx = makeContext({ data: { model: { id: 'claude-opus-4-6[1m]' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('claude-opus-4-6[1m]');
        });
    });

    describe('effort coloring', () => {
        it('wraps the name in inline color for a known effort level', () => {
            const out = new ModelWidget().render(EFFORT_RAW, modelContext('high'), DEFAULT_SETTINGS) ?? '';
            expect(stripSgrCodes(out)).toBe('Opus 4.6');
            expect(out).not.toBe('Opus 4.6'); // carries inline color codes
            expect(colorCodes(out).length).toBe(1); // solid level = single color
        });

        it('uses a different color for different levels', () => {
            const widget = new ModelWidget();
            const low = widget.render(EFFORT_RAW, modelContext('low'), DEFAULT_SETTINGS) ?? '';
            const high = widget.render(EFFORT_RAW, modelContext('high'), DEFAULT_SETTINGS) ?? '';
            expect(colorCodes(low)).not.toEqual(colorCodes(high));
            expect(stripSgrCodes(low)).toBe('Opus 4.6');
        });

        it('renders max as a multi-color per-character rainbow', () => {
            const out = new ModelWidget().render(EFFORT_RAW, modelContext('max'), DEFAULT_SETTINGS) ?? '';
            expect(stripSgrCodes(out)).toBe('Opus 4.6');
            expect(colorCodes(out).length).toBeGreaterThan(1); // many colors across characters
        });

        it('falls back to the plain name when effort is unresolved', () => {
            // explicit null effort in status JSON resolves to "default" (no level)
            const out = new ModelWidget().render(EFFORT_RAW, modelContext(null), DEFAULT_SETTINGS);
            expect(out).toBe('Opus 4.6');
        });

        it('does not color when the toggle is off', () => {
            const out = new ModelWidget().render(RAW_ITEM, modelContext('high'), DEFAULT_SETTINGS);
            expect(out).toBe('Opus 4.6');
        });

        it('keeps the Model: label and only recolors the value', () => {
            const item: WidgetItem = { id: 'model', type: 'model', metadata: { effortColor: 'true' } };
            const out = new ModelWidget().render(item, modelContext('high'), DEFAULT_SETTINGS) ?? '';
            expect(stripSgrCodes(out)).toBe('Model: Opus 4.6');
        });

        it('colors the preview when the toggle is on', () => {
            const item: WidgetItem = { id: 'model', type: 'model', rawValue: true, metadata: { effortColor: 'true' } };
            const out = new ModelWidget().render(item, makeContext({ isPreview: true }), DEFAULT_SETTINGS) ?? '';
            expect(stripSgrCodes(out)).toBe('Claude');
            expect(colorCodes(out).length).toBe(1);
        });
    });

    describe('effort color toggle', () => {
        it('toggles effortColor metadata via editor action', () => {
            const widget = new ModelWidget();
            const item: WidgetItem = { id: 'model', type: 'model' };
            const on = widget.handleEditorAction('toggle-effort-color', item);
            expect(on?.metadata?.effortColor).toBe('true');
            const off = widget.handleEditorAction('toggle-effort-color', on ?? item);
            expect(off?.metadata?.effortColor).toBe('false');
        });

        it('reports inline colors only when the toggle is on', () => {
            const widget = new ModelWidget();
            expect(widget.usesInlineColors({ id: 'model', type: 'model' })).toBe(false);
            expect(widget.usesInlineColors({ id: 'model', type: 'model', metadata: { effortColor: 'true' } })).toBe(true);
        });

        it('shows an effort-color modifier in the editor display', () => {
            const widget = new ModelWidget();
            expect(widget.getEditorDisplay({ id: 'model', type: 'model' }).modifierText).toBeUndefined();
            expect(widget.getEditorDisplay({ id: 'model', type: 'model', metadata: { effortColor: 'true' } }).modifierText).toBe('(effort color)');
        });
    });
});
