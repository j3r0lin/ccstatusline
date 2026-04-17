import {
    describe,
    expect,
    it
} from 'vitest';

import type { RenderContext } from '../../types/RenderContext';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import type { WidgetItem } from '../../types/Widget';
import { getVisibleText } from '../../utils/ansi';
import { IdleWidget } from '../Idle';

function render(widget: IdleWidget, item: WidgetItem, context: RenderContext = {}): string | null {
    return widget.render(item, context, DEFAULT_SETTINGS);
}

function visible(output: string | null): string {
    return getVisibleText(output ?? '');
}

describe('IdleWidget', () => {
    const baseItem: WidgetItem = { id: 'idle', type: 'idle' };

    it('renders preview text with icon', () => {
        const widget = new IdleWidget();
        expect(visible(render(widget, baseItem, { isPreview: true }))).toBe('Idle: 󰔛 2m');
    });

    it('renders preview in raw mode', () => {
        const widget = new IdleWidget();
        expect(visible(render(widget, { ...baseItem, rawValue: true }, { isPreview: true }))).toBe('󰔛 2m');
    });

    it('returns null when no completion data', () => {
        const widget = new IdleWidget();
        expect(render(widget, baseItem, {})).toBeNull();
        expect(render(widget, baseItem, { lastCompletionMs: null })).toBeNull();
    });

    it('renders elapsed seconds when under 1 minute', () => {
        const widget = new IdleWidget();
        expect(visible(render(widget, baseItem, { lastCompletionMs: Date.now() - 30_000 }))).toBe('Idle: 󰔛 30s');
    });

    it('renders minutes without seconds', () => {
        const widget = new IdleWidget();
        expect(visible(render(widget, baseItem, { lastCompletionMs: Date.now() - 150_000 }))).toBe('Idle: 󰔛 2m');
    });

    it('renders large elapsed time', () => {
        const widget = new IdleWidget();
        expect(visible(render(widget, baseItem, { lastCompletionMs: Date.now() - 600_000 }))).toBe('Idle: 󰔛 10m');
    });

    it('renders raw value without label', () => {
        const widget = new IdleWidget();
        const rawItem = { ...baseItem, rawValue: true };
        expect(visible(render(widget, rawItem, { lastCompletionMs: Date.now() - 90_000 }))).toBe('󰔛 1m');
    });

    it('has correct metadata', () => {
        const widget = new IdleWidget();
        expect(widget.getDefaultColor()).toBe('brightGreen');
        expect(widget.getCategory()).toBe('Session');
        expect(widget.supportsRawValue()).toBe(true);
        expect(widget.supportsColors(baseItem)).toBe(false);
    });
});