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

import type { RenderContext } from '../../types/RenderContext';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import type { WidgetItem } from '../../types/Widget';
import { stripSgrCodes } from '../../utils/ansi';
import * as usage from '../../utils/usage';
import type { UsageWindowMetrics } from '../../utils/usage-types';
import { MonthlyUsageWidget } from '../MonthlyUsage';

import { runUsagePercentWidgetSuite } from './helpers/usage-widget-suites';

let mockGetUsageErrorMessage: { mockReturnValue: (value: string) => void };
const usageErrorMessageMock = {
    mockReturnValue(value: string): void {
        mockGetUsageErrorMessage.mockReturnValue(value);
    }
};

const halfElapsedWindow: UsageWindowMetrics = {
    sessionDurationMs: 2592000000,
    elapsedMs: 1296000000,
    remainingMs: 1296000000,
    elapsedPercent: 50,
    remainingPercent: 50
};

function render(widget: MonthlyUsageWidget, item: WidgetItem, context: RenderContext = {}): string | null {
    return widget.render(item, context, DEFAULT_SETTINGS);
}

describe('MonthlyUsageWidget', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mockGetUsageErrorMessage = vi.spyOn(usage, 'getUsageErrorMessage');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the time cursor in short bar modes', () => {
        const widget = new MonthlyUsageWidget();
        const context: RenderContext = { usageData: { monthlyUsage: 20 } };

        vi.spyOn(usage, 'resolveMonthlyUsageWindow').mockReturnValue(halfElapsedWindow);

        expect(render(widget, {
            id: 'monthly',
            type: 'monthly-usage',
            metadata: { cursor: 'true', display: 'slider' }
        }, context)).toBe('Monthly: ▓▓░░░│░░░░ 20.0%');
        expect(render(widget, {
            id: 'monthly',
            type: 'monthly-usage',
            metadata: { cursor: 'true', display: 'slider-only' }
        }, context)).toBe('Monthly: ▓▓░░░│░░░░');
    });

    describe('pace coloring', () => {
        // Runtime forces truecolor globally (ccstatusline.ts / tui.tsx); mirror
        // that here so the auto color actually emits SGR codes.
        let originalChalkLevel: typeof chalk.level;
        beforeAll(() => {
            originalChalkLevel = chalk.level;
            chalk.level = 3;
        });
        afterAll(() => {
            chalk.level = originalChalkLevel;
        });

        function windowAt(elapsedPercent: number): UsageWindowMetrics {
            return {
                sessionDurationMs: 2592000000,
                elapsedMs: (elapsedPercent / 100) * 2592000000,
                remainingMs: ((100 - elapsedPercent) / 100) * 2592000000,
                elapsedPercent,
                remainingPercent: 100 - elapsedPercent
            };
        }

        const item: WidgetItem = { id: 'monthly', type: 'monthly-usage' };

        it('shows reserve as an uncolored negative delta', () => {
            const widget = new MonthlyUsageWidget();
            const context: RenderContext = { usageData: { monthlyUsage: 55 } };

            vi.spyOn(usage, 'resolveMonthlyUsageWindow').mockReturnValue(windowAt(90));

            const output = render(widget, item, context);
            expect(output).toBe('Monthly: 55.0% -35');
            expect(output).toBe(stripSgrCodes(output ?? ''));
        });

        it('colors only the delta when spending runs ahead', () => {
            const widget = new MonthlyUsageWidget();
            const context: RenderContext = { usageData: { monthlyUsage: 55 } };

            vi.spyOn(usage, 'resolveMonthlyUsageWindow').mockReturnValue(windowAt(20));

            const output = render(widget, item, context) ?? '';
            expect(stripSgrCodes(output)).toBe('Monthly: 55.0% +35');
            expect(output.startsWith('Monthly: 55.0% ')).toBe(true);
            expect(output).not.toBe(stripSgrCodes(output));
        });

        it('leaves the percent alone so the configured color still applies', () => {
            const widget = new MonthlyUsageWidget();
            const context: RenderContext = { usageData: { monthlyUsage: 55 } };
            const explicit: WidgetItem = { ...item, color: 'brightBlue' };

            vi.spyOn(usage, 'resolveMonthlyUsageWindow').mockReturnValue(windowAt(20));

            expect(render(widget, explicit, context)).toBe(render(widget, item, context));
        });
    });

    it('hides when monthly usage data is absent and there is no error', () => {
        const widget = new MonthlyUsageWidget();

        expect(render(widget, {
            id: 'monthly',
            type: 'monthly-usage'
        }, { usageData: { weeklyUsage: 30 } })).toBeNull();
    });

    it('hides when the weekly slot has promoted the tighter monthly cap', () => {
        const widget = new MonthlyUsageWidget();

        expect(render(widget, {
            id: 'monthly',
            type: 'monthly-usage'
        }, {
            hasWeeklyUsageWidget: true,
            usageData: { weeklyUsage: 10, monthlyUsage: 55, monthlyResetAt: '2026-09-12T12:24:00.000Z' }
        })).toBeNull();
    });

    it('still renders alongside weekly when monthly is the looser cap', () => {
        const widget = new MonthlyUsageWidget();

        // Covers visibility, so drop the window to keep the pace delta out of
        // the expectation.
        vi.spyOn(usage, 'resolveMonthlyUsageWindow').mockReturnValue(null);

        expect(render(widget, {
            id: 'monthly',
            type: 'monthly-usage'
        }, {
            hasWeeklyUsageWidget: true,
            usageData: { weeklyUsage: 55, monthlyUsage: 10, monthlyResetAt: '2026-09-12T12:24:00.000Z' }
        })).toBe('Monthly: 10.0%');
    });

    it('still renders when no weekly-usage widget is configured', () => {
        const widget = new MonthlyUsageWidget();

        // Covers visibility, so drop the window to keep the pace delta out of
        // the expectation.
        vi.spyOn(usage, 'resolveMonthlyUsageWindow').mockReturnValue(null);

        expect(render(widget, {
            id: 'monthly',
            type: 'monthly-usage'
        }, {
            hasWeeklyUsageWidget: false,
            usageData: { weeklyUsage: 10, monthlyUsage: 55, monthlyResetAt: '2026-09-12T12:24:00.000Z' }
        })).toBe('Monthly: 55.0%');
    });

    runUsagePercentWidgetSuite({
        baseItem: { id: 'monthly', type: 'monthly-usage' },
        createWidget: () => new MonthlyUsageWidget(),
        errorMessageMock: usageErrorMessageMock,
        expectedInvertedTime: 'Monthly: 57.9%',
        expectedModifierText: '(long bar, remaining)',
        expectedPreviewInvertedTime: 'Monthly: 88.0%',
        expectedProgress: 'Monthly: [███████████████████░░░░░░░░░░░░░] 57.9%',
        expectedRawInvertedTime: '57.9%',
        expectedRawProgress: '[███████░░░░░░░░░] 42.1%',
        expectedRawTime: '42.1%',
        expectedTime: 'Monthly: 42.1%',
        modifierItem: {
            id: 'monthly',
            type: 'monthly-usage',
            metadata: { display: 'progress', invert: 'true' }
        },
        progressItem: {
            id: 'monthly',
            type: 'monthly-usage',
            metadata: { display: 'progress', invert: 'true' }
        },
        rawProgressItem: {
            id: 'monthly',
            type: 'monthly-usage',
            rawValue: true,
            metadata: { display: 'progress-short' }
        },
        rawTimeItem: {
            id: 'monthly',
            type: 'monthly-usage',
            rawValue: true
        },
        render,
        usageField: 'monthlyUsage',
        usageValue: 42.06
    });
});
