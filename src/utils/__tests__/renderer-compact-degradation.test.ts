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

describe('renderer compact separators', () => {
    const items: WidgetItem[] = [
        { id: 'a', type: 'custom-text', customText: 'alpha' },
        { id: 's1', type: 'separator', character: '|' },
        { id: 'b', type: 'custom-text', customText: 'beta' },
        { id: 's2', type: 'separator', character: '|' },
        { id: 'c', type: 'custom-text', customText: 'gamma' }
    ];

    function renderAt(terminalWidth: number): string {
        const context: RenderContext = { isPreview: false, terminalWidth };
        const preRendered = preRenderAllWidgets([items], settings, context);
        const maxWidths = calculateMaxWidthsFromPreRendered(preRendered, settings);
        return stripSgrCodes(renderStatusLine(items, settings, context, preRendered[0] ?? [], maxWidths));
    }

    it('keeps spaced separators when the line fits', () => {
        expect(renderAt(100)).toBe('alpha | beta | gamma');
    });

    it('tightens separators instead of truncating when that is enough', () => {
        // 21 columns spaced, 17 tight; usable width is terminalWidth - 6
        expect(renderAt(23)).toBe('alpha|beta|gamma');
    });

    it('still truncates when tight separators do not fit either', () => {
        expect(renderAt(14)).toContain('...');
    });
});
