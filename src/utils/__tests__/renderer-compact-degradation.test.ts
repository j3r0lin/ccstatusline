import {
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
import {
    getVisibleWidth,
    stripSgrCodes
} from '../ansi';
import {
    calculateMaxWidthsFromPreRendered,
    preRenderAllWidgets,
    renderStatusLine
} from '../renderer';

const settings: Settings = { ...DEFAULT_SETTINGS, flexMode: 'full' };

const widgets: WidgetItem[] = [
    { id: 'ctx', type: 'context-bar', metadata: { display: 'slider' } },
    { id: 'sep', type: 'separator' },
    { id: 'txt', type: 'custom-text', customText: 'tail-text' }
];

function render(terminalWidth: number): string {
    const context: RenderContext = {
        isPreview: false,
        terminalWidth,
        data: {
            context_window: {
                context_window_size: 200000,
                current_usage: { input_tokens: 60000 }
            }
        }
    };
    const preRendered = preRenderAllWidgets([widgets], settings, context);
    const maxWidths = calculateMaxWidthsFromPreRendered(preRendered, settings);
    return stripSgrCodes(renderStatusLine(widgets, settings, context, preRendered[0] ?? [], maxWidths));
}

describe('renderer compact degradation', () => {
    const wide = render(200);

    it('keeps the full context bar when the line fits', () => {
        expect(wide).toContain('60k/200k');
        expect(wide).toContain('tail-text');
    });

    it('shows a shorter context bar instead of cutting the line when it overflows', () => {
        const width = getVisibleWidth(wide) + 6 - 4;
        const narrow = render(width);

        expect(narrow).not.toContain('...');
        expect(narrow).toContain('tail-text');
        expect(getVisibleWidth(narrow)).toBeLessThan(getVisibleWidth(wide));
    });

    it('still truncates when compact variants cannot make the line fit', () => {
        expect(render(10)).toContain('...');
    });
});
