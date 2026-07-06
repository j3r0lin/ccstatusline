import chalk from 'chalk';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it
} from 'vitest';

import type { RenderContext } from '../../types/RenderContext';
import {
    DEFAULT_SETTINGS,
    type Settings
} from '../../types/Settings';
import type { WidgetItem } from '../../types/Widget';
import { stripSgrCodes } from '../ansi';
import {
    preRenderAllWidgets,
    renderStatusLine
} from '../renderer';

function createSettings(overrides: Partial<Settings> = {}): Settings {
    return {
        ...DEFAULT_SETTINGS,
        ...overrides,
        powerline: {
            ...DEFAULT_SETTINGS.powerline,
            ...(overrides.powerline ?? {})
        }
    };
}

// Render a single line through the real preRender + renderStatusLine pipeline.
function render(widget: WidgetItem, content: string, settingsOverrides: Partial<Settings> = {}): string {
    const settings = createSettings({ colorLevel: 3, ...settingsOverrides });
    const context: RenderContext = { isPreview: false, terminalWidth: 200 };
    const preRendered = [{ content, plainLength: stripSgrCodes(content).length, widget }];
    return renderStatusLine([widget], settings, context, preRendered, []);
}

const INLINE = '\x1b[31mOpus\x1b[0m'; // model name pre-colored by the widget

describe('renderer inline-color preservation', () => {
    // Mirror the runtime truecolor setting so the renderer's normal coloring path
    // actually emits SGR codes (chalk defaults to level 0 in tests).
    let originalChalkLevel: typeof chalk.level;
    beforeAll(() => {
        originalChalkLevel = chalk.level;
        chalk.level = 3;
    });
    afterAll(() => {
        chalk.level = originalChalkLevel;
    });

    it('preserves a widget\'s inline colors when usesInlineColors is on and content has SGR', () => {
        const widget: WidgetItem = { id: 'm', type: 'model', color: 'blue', metadata: { effortColor: 'true' } };
        const out = render(widget, INLINE);
        expect(out).toContain('\x1b[31mOpus'); // original inline color survives
        expect(stripSgrCodes(out)).toContain('Opus');
    });

    it('applies the configured color when the widget emits plain text (no SGR)', () => {
        const widget: WidgetItem = { id: 'm', type: 'model', color: 'blue', metadata: { effortColor: 'true' } };
        const out = render(widget, 'Opus');
        expect(out).not.toContain('\x1b[31m'); // no inline color to preserve
        expect(out).not.toBe('Opus'); // renderer applied its own color
        expect(stripSgrCodes(out)).toContain('Opus');
    });

    it('applies the configured color when the widget does not opt into inline colors', () => {
        const widget: WidgetItem = { id: 'm', type: 'model', color: 'blue' };
        const out = render(widget, INLINE);
        // Without usesInlineColors, the renderer re-colors the whole content;
        // the configured blue is applied rather than the inline red being treated as authoritative.
        expect(stripSgrCodes(out)).toContain('Opus');
        expect(out).not.toBe(INLINE);
    });

    it('preserves inline colors through preRenderAllWidgets for an effort-colored model', () => {
        const widget: WidgetItem = { id: 'm', type: 'model', rawValue: true, metadata: { effortColor: 'true' } };
        const settings = createSettings({ colorLevel: 3 });
        const context: RenderContext = {
            isPreview: false,
            terminalWidth: 200,
            data: { model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' }, effort: { level: 'high' } }
        };
        const preRendered = preRenderAllWidgets([[widget]], settings, context);
        const out = renderStatusLine([widget], settings, context, preRendered[0] ?? [], []);
        expect(stripSgrCodes(out)).toBe('Opus 4.6');
        expect(out).not.toBe('Opus 4.6'); // effort color preserved end-to-end
    });
});
