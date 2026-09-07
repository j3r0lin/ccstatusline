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
import { stripSgrCodes } from '../ansi';
import {
    calculateMaxWidthsFromPreRendered,
    preRenderAllWidgets,
    renderStatusLine
} from '../renderer';

function createSettings(overrides: Partial<Settings> = {}): Settings {
    return {
        ...DEFAULT_SETTINGS,
        colorLevel: 0,
        ...overrides,
        powerline: {
            ...DEFAULT_SETTINGS.powerline,
            ...(overrides.powerline ?? {})
        }
    };
}

function renderLine(widgets: WidgetItem[], contextOverrides: Partial<RenderContext> = {}): string {
    const settings = createSettings();
    const context: RenderContext = {
        isPreview: false,
        terminalWidth: 200,
        hasSessionUsageWidget: widgets.some(item => item.type === 'session-usage'),
        hasWeeklyUsageWidget: widgets.some(item => item.type === 'weekly-usage'),
        hasResetTimerWidget: widgets.some(item => item.type === 'reset-timer'),
        ...contextOverrides
    };
    const preRenderedLines = preRenderAllWidgets([widgets], settings, context);
    const maxWidths = calculateMaxWidthsFromPreRendered(preRenderedLines, settings);
    return stripSgrCodes(renderStatusLine(widgets, settings, context, preRenderedLines[0] ?? [], maxWidths));
}

describe('weekly reset promotion through the status line', () => {
    it('keeps the promoted weekly countdown beside the session bar instead of behind the group separator', () => {
        // Providers with no five-hour window promote weekly into session-usage.
        // The reset-timer sits behind a spacer; the dedicated weekly pair sits
        // behind the next group separator. The countdown must follow the bar
        // it describes, not jump the group boundary.
        const widgets: WidgetItem[] = [
            {
                id: 'session',
                type: 'session-usage',
                rawValue: true,
                metadata: { display: 'slider', cursor: 'true' }
            },
            { id: 'reset-space', type: 'separator', character: ' ' },
            {
                id: 'reset',
                type: 'reset-timer',
                rawValue: true,
                metadata: { compact: 'true' }
            },
            { id: 'weekly-sep', type: 'separator' },
            {
                id: 'weekly',
                type: 'weekly-usage',
                rawValue: true,
                metadata: { display: 'time', prefix: 'W ' }
            },
            { id: 'weekly-reset-space', type: 'separator', character: ' ' },
            {
                id: 'weekly-reset',
                type: 'weekly-reset-timer',
                rawValue: true,
                metadata: { compact: 'true' }
            },
            { id: 'cost-sep', type: 'separator' },
            { id: 'cost', type: 'session-cost', rawValue: true }
        ];

        const out = renderLine(widgets, {
            usageData: {
                weeklyUsage: 11,
                weeklyResetAt: new Date(Date.now() + (2.5 * 24 * 60 * 60 * 1000)).toISOString()
            },
            data: { cost: { total_cost_usd: 0.16 } }
        });

        expect(out).toContain('11%');
        expect(out).toContain('2d');
        expect(out).toContain('$0.16');
        expect(out).not.toMatch(/\|\s*2d/);
    });
});
