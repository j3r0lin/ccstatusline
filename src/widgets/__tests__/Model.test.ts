import chalk from 'chalk';
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type {
    RenderContext,
    WidgetItem
} from '../../types';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import { useModelNamesFixture } from '../../utils/__tests__/model-names-fixture';
import { stripSgrCodes } from '../../utils/ansi';
import * as magpieAccountLabel from '../../utils/magpie-account-label';
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
    let restoreNames: () => void;
    // Per test: the suites' vi.restoreAllMocks() would otherwise undo the homedir stub.
    beforeEach(() => {
        restoreNames = useModelNamesFixture();
    });
    afterEach(() => {
        restoreNames();
    });
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
    // Stub per test rather than with vi.mock: bun's runner keeps one module
    // registry across files, so a module-level mock leaks into every later file.
    beforeEach(() => {
        vi.spyOn(magpieAccountLabel, 'resolveMagpieAccountLabel').mockReturnValue(null);
        vi.spyOn(magpieAccountLabel, 'resolveMagpieModel').mockReturnValue(undefined);
    });
    afterEach(() => {
        vi.restoreAllMocks();
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

        it('renders kimi-for-coding as the K2 family without a pinned version', () => {
            const ctx = makeContext({ data: { model: { id: 'kimi-for-coding' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('K2');
        });

        it('renders kimi-for-coding-highspeed as "K2 Fast"', () => {
            const ctx = makeContext({ data: { model: { id: 'kimi-for-coding-highspeed' } } });
            expect(stripSgrCodes(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS) ?? '')).toBe('K2 ↯');
        });

        it('prefers the kimi-for-coding-highspeed alias over its display_name', () => {
            const ctx = makeContext({ data: { model: { id: 'kimi-for-coding-highspeed', display_name: 'Kimi for Coding Highspeed' } } });
            expect(stripSgrCodes(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS) ?? '')).toBe('K2 ↯');
        });

        it('renders k3[1m] id as "K3"', () => {
            const ctx = makeContext({ data: { model: { id: 'k3[1m]' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('K3');
        });

        it('renders k3 id as "K3"', () => {
            const ctx = makeContext({ data: { model: { id: 'k3' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('K3');
        });

        it('prefers k3 id over kimi display_name', () => {
            const ctx = makeContext({ data: { model: { id: 'k3[1m]', display_name: 'Kimi K3' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('K3');
        });

        it('renders k3-256k id as "K3"', () => {
            const ctx = makeContext({ data: { model: { id: 'k3-256k' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('K3');
        });

        it('prefers k3-256k id over kimi display_name', () => {
            const ctx = makeContext({ data: { model: { id: 'k3-256k', display_name: 'Kimi K3 256K' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('K3');
        });

        it('renders grok-4.5 id as "Grok 4.5"', () => {
            const ctx = makeContext({ data: { model: { id: 'grok-4.5' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Grok 4.5');
        });

        it('renders xai/grok-4 id as "Grok 4"', () => {
            const ctx = makeContext({ data: { model: { id: 'xai/grok-4' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Grok 4');
        });

        it('renders gpt-5.6-sol as "Sol 5.6"', () => {
            const ctx = makeContext({ data: { model: { id: 'gpt-5.6-sol' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Sol 5.6');
        });

        it.each([
            ['gpt-6.1-sol', 'Sol 6.1'],
            ['openai/gpt-6.1-sol', 'Sol 6.1'],
            ['grok-4.7-build-fast', 'Grok 4.7 ↯'],
            ['deepseek-v4.1-flash-free', 'DSF 4.1 Free'],
            ['glm-5.3-flash-free', 'glm-5.3-flash-free']
        ])('renders %s as %s', (id, expected) => {
            const widget = new ModelWidget();
            expect(stripSgrCodes(widget.render(RAW_ITEM, makeContext({ data: { model: { id } } }), DEFAULT_SETTINGS) ?? '')).toBe(expected);
            expect(stripSgrCodes(widget.render(RAW_ITEM, makeContext({ data: { model: id } }), DEFAULT_SETTINGS) ?? '')).toBe(expected);
        });

        it('shows a name from the whole-name table', () => {
            const ctx = makeContext({ data: { model: { id: 'kimi-for-coding-highspeed' } } });
            expect(stripSgrCodes(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS) ?? '')).toBe('K2 ↯');
        });

        it('only cleans the id when the table file is missing', () => {
            restoreNames();
            restoreNames = useModelNamesFixture(null);
            const ctx = makeContext({ data: { model: { id: 'deepseek/deepseek-v4.1-flash-free[1m]' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('deepseek-v4.1-flash-free');
        });

        it('renders gpt-5.6-terra as "Terra 5.6"', () => {
            const ctx = makeContext({ data: { model: { id: 'gpt-5.6-terra' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Terra 5.6');
        });

        it('renders a provider-prefixed GPT model as variant then version', () => {
            const ctx = makeContext({ data: { model: { id: 'openai/gpt-5.6-luna' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Luna 5.6');
        });

        it('prefers the versioned model id over a shorter display_name', () => {
            const ctx = makeContext({ data: { model: { id: 'gpt-5.6-sol', display_name: 'Sol' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Sol 5.6');
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

        it('uses the label override in place of the default label', () => {
            const ctx = makeContext({ data: { model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' } } });
            expect(new ModelWidget().render({ ...ITEM, metadata: { label: 'M ' } }, ctx, DEFAULT_SETTINGS)).toBe('M Opus 4.6');
        });

        it('names the model from its id when display_name is absent', () => {
            const ctx = makeContext({ data: { model: { id: 'claude-opus-4-6[1m]' } } });
            expect(new ModelWidget().render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Opus 4.6');
        });
    });

    describe('session fast mode', () => {
        it.each([
            ['gpt-6.1-sol', true, 'Sol 6.1 ↯'],
            ['gpt-6.1-sol', false, 'Sol 6.1'],
            ['gpt-6.1-sol', undefined, 'Sol 6.1'],
            ['grok-4.7-build-fast', true, 'Grok 4.7 ↯'],
            ['grok-4.7-build-fast', false, 'Grok 4.7 ↯'],
            ['grok-4.7-build-fast', undefined, 'Grok 4.7 ↯'],
            ['kimi-for-coding-highspeed', true, 'K2 ↯']
        ] as const)('renders %s with fast_mode=%s as %s', (id, fastMode, expected) => {
            const widget = new ModelWidget();
            const ctx = makeContext({ data: { model: { id }, fast_mode: fastMode } });
            expect(stripSgrCodes(widget.render(RAW_ITEM, ctx, DEFAULT_SETTINGS) ?? '')).toBe(expected);
            expect(stripSgrCodes(widget.render(ITEM, ctx, DEFAULT_SETTINGS) ?? '')).toBe(`Model: ${expected}`);
            expect(stripSgrCodes(widget.render(RAW_ITEM, makeContext({ data: { model: id, fast_mode: fastMode } }), DEFAULT_SETTINGS) ?? '')).toBe(expected);
        });

        it('reflects fast mode changes within a session', () => {
            const widget = new ModelWidget();
            const data = { model: { id: 'gpt-6.1-sol' }, fast_mode: false };
            const ctx = makeContext({ data });
            expect(widget.render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Sol 6.1');
            data.fast_mode = true;
            expect(stripSgrCodes(widget.render(RAW_ITEM, ctx, DEFAULT_SETTINGS) ?? '')).toBe('Sol 6.1 ↯');
            data.fast_mode = false;
            expect(widget.render(RAW_ITEM, ctx, DEFAULT_SETTINGS)).toBe('Sol 6.1');
        });

        it('preserves effort coloring with the Fast suffix', () => {
            const ctx = makeContext({ data: { model: { id: 'gpt-6.1-sol' }, fast_mode: true, effort: { level: 'high' } } });
            const out = new ModelWidget().render(EFFORT_RAW, ctx, DEFAULT_SETTINGS) ?? '';
            expect(stripSgrCodes(out)).toBe('Sol 6.1 ↯');
            expect(colorCodes(out).length).toBeGreaterThan(0);
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

        it('keeps the Fast icon color independent of effort coloring', () => {
            const widget = new ModelWidget();
            const ctx = makeContext({ data: { model: { id: 'gpt-6.1-sol' }, fast_mode: true, effort: { level: 'high' } } });
            const settings = { ...DEFAULT_SETTINGS, colorLevel: 3 as const };
            const plain = widget.render(RAW_ITEM, ctx, settings) ?? '';
            const colored = widget.render(EFFORT_RAW, ctx, settings) ?? '';
            expect(stripSgrCodes(plain)).toBe('Sol 6.1 ↯');
            expect(stripSgrCodes(colored)).toBe('Sol 6.1 ↯');
            expect(plain).toContain('\x1b[38;2;255;120;20m↯');
            expect(colored).toContain('\x1b[38;2;255;120;20m↯');
        });

        it('renders the Fast icon without ANSI in no-color mode', () => {
            const ctx = makeContext({ data: { model: { id: 'gpt-6.1-sol' }, fast_mode: true, effort: { level: 'high' } } });
            const settings = { ...DEFAULT_SETTINGS, colorLevel: 0 as const };
            expect(new ModelWidget().render(EFFORT_RAW, ctx, settings)).toBe('Sol 6.1 ↯');
            expect(new ModelWidget().render(ITEM, ctx, settings)).toBe('Model: Sol 6.1 ↯');
        });

        it('shows an effort-color modifier in the editor display', () => {
            const widget = new ModelWidget();
            expect(widget.getEditorDisplay({ id: 'model', type: 'model' }).modifierText).toBeUndefined();
            expect(widget.getEditorDisplay({ id: 'model', type: 'model', metadata: { effortColor: 'true' } }).modifierText).toBe('(effort color)');
        });
    });
});
