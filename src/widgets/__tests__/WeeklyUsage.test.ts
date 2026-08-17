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
import { applyColors } from '../../utils/colors';
import * as usage from '../../utils/usage';
import type { UsageWindowMetrics } from '../../utils/usage-types';
import { WeeklyUsageWidget } from '../WeeklyUsage';

import { runUsagePercentWidgetSuite } from './helpers/usage-widget-suites';

let mockGetUsageErrorMessage: { mockReturnValue: (value: string) => void };
const usageErrorMessageMock = {
    mockReturnValue(value: string): void {
        mockGetUsageErrorMessage.mockReturnValue(value);
    }
};

const halfElapsedWindow: UsageWindowMetrics = {
    sessionDurationMs: 604800000,
    elapsedMs: 302400000,
    remainingMs: 302400000,
    elapsedPercent: 50,
    remainingPercent: 50
};

function render(widget: WeeklyUsageWidget, item: WidgetItem, context: RenderContext = {}): string | null {
    return widget.render(item, context, DEFAULT_SETTINGS);
}

describe('WeeklyUsageWidget', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mockGetUsageErrorMessage = vi.spyOn(usage, 'getUsageErrorMessage');
        // makeUsageProgressBar no longer used; WeeklyUsage uses makeTimerProgressBar directly
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the time cursor in short bar modes', () => {
        const widget = new WeeklyUsageWidget();
        const context: RenderContext = { usageData: { weeklyUsage: 20 } };

        vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(halfElapsedWindow);

        expect(stripSgrCodes(render(widget, {
            id: 'weekly',
            type: 'weekly-usage',
            metadata: { cursor: 'true', display: 'slider' }
        // The weekly pace baseline counts workdays, so the delta shifts with the
        // current weekday; this case is about the cursor, not the number.
        }, context) ?? '')).toMatch(/^Weekly: ▓▓░░░│░░░░ 20% ▾\d+$/);
        expect(render(widget, {
            id: 'weekly',
            type: 'weekly-usage',
            metadata: { cursor: 'true', display: 'slider-only' }
        }, context)).toBe('Weekly: ▓▓░░░│░░░░');
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

        // The pace baseline counts workdays, so the rendered delta depends on
        // which weekday "now" is. Pin it to a Wednesday for stable output.
        beforeEach(() => {
            vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-08-19T12:00:00').getTime());
        });

        function renderColored(item: WidgetItem, context: RenderContext): string | null {
            return new WeeklyUsageWidget().render(item, context, DEFAULT_SETTINGS);
        }

        function windowAt(elapsedPercent: number): UsageWindowMetrics {
            return {
                sessionDurationMs: 604800000,
                elapsedMs: (elapsedPercent / 100) * 604800000,
                remainingMs: ((100 - elapsedPercent) / 100) * 604800000,
                elapsedPercent,
                remainingPercent: 100 - elapsedPercent
            };
        }

        const item: WidgetItem = { id: 'weekly', type: 'weekly-usage' };

        it('colors reserve as well as deficit', () => {
            const context: RenderContext = { usageData: { weeklyUsage: 55 } };

            vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(windowAt(90));

            const output = renderColored(item, context) ?? '';
            expect(stripSgrCodes(output)).toMatch(/^Weekly: 55% ▾\d+$/);
            expect(output).not.toBe(stripSgrCodes(output));
        });

        it('appends the delta when spending runs ahead', () => {
            const context: RenderContext = { usageData: { weeklyUsage: 55 } };

            vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(windowAt(20));

            const output = renderColored(item, context) ?? '';
            expect(stripSgrCodes(output)).toMatch(/^Weekly: 55% ▴\d+$/);
        });

        it('says nothing when the window has not started yet', () => {
            const context: RenderContext = { usageData: { weeklyUsage: 55 } };

            vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(windowAt(0));

            expect(renderColored(item, context)).toBe('Weekly: 55%');
        });

        it('colors only the delta, leaving the percent plain', () => {
            const context: RenderContext = { usageData: { weeklyUsage: 55 } };

            vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(windowAt(20));

            const output = renderColored(item, context) ?? '';
            expect(output.startsWith('Weekly: 55% ')).toBe(true);
            expect(output).not.toBe(stripSgrCodes(output));
        });

        it('uses the monthly window for pace when monthly is promoted', () => {
            const context: RenderContext = {
                usageData: {
                    weeklyUsage: 10,
                    monthlyUsage: 55
                }
            };

            vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(windowAt(20));
            vi.spyOn(usage, 'resolveMonthlyUsageWindow').mockReturnValue(windowAt(90));
            expect(stripSgrCodes(renderColored(item, context) ?? '')).toMatch(/^Monthly: 55% ▾\d+$/);

            vi.spyOn(usage, 'resolveMonthlyUsageWindow').mockReturnValue(windowAt(20));
            expect(stripSgrCodes(renderColored(item, context) ?? '')).toMatch(/^Monthly: 55% ▴\d+$/);
        });

        it('keeps the configured color on the percent', () => {
            const context: RenderContext = { usageData: { weeklyUsage: 55 } };
            const explicit: WidgetItem = { ...item, color: 'brightBlue' };

            vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(windowAt(20));

            const output = renderColored(explicit, context) ?? '';
            expect(output).toContain(applyColors('55%', 'brightBlue', undefined, false, 'ansi256'));
            expect(stripSgrCodes(output)).toMatch(/^Weekly: 55% ▴\d+$/);
        });

        it('shows the delta in bar modes too, so the cursor is not the only cue', () => {
            const context: RenderContext = { usageData: { weeklyUsage: 55 } };
            const barItem: WidgetItem = { ...item, metadata: { display: 'slider' } };

            vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(windowAt(20));

            expect(stripSgrCodes(renderColored(barItem, context) ?? '')).toMatch(/55% ▴\d+$/);
        });

        it('keeps slider-only a bare bar', () => {
            const context: RenderContext = { usageData: { weeklyUsage: 55 } };
            const barItem: WidgetItem = { ...item, metadata: { display: 'slider-only' } };

            vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(windowAt(20));

            expect(renderColored(barItem, context)).not.toMatch(/%/);
        });
    });

    it('hides when session-usage is present and has promoted weekly into the primary slot', () => {
        const widget = new WeeklyUsageWidget();

        expect(render(widget, {
            id: 'weekly',
            type: 'weekly-usage'
        }, {
            hasSessionUsageWidget: true,
            usageData: { weeklyUsage: 30 }
        })).toBeNull();
    });

    it('still renders when session usage exists alongside weekly', () => {
        const widget = new WeeklyUsageWidget();

        expect(render(widget, {
            id: 'weekly',
            type: 'weekly-usage'
        }, {
            hasSessionUsageWidget: true,
            usageData: { sessionUsage: 12, weeklyUsage: 30 }
        })).toBe('Weekly: 30%');
    });

    it('still renders weekly alone when session-usage is not configured', () => {
        const widget = new WeeklyUsageWidget();

        expect(render(widget, {
            id: 'weekly',
            type: 'weekly-usage'
        }, {
            hasSessionUsageWidget: false,
            usageData: { weeklyUsage: 30 }
        })).toBe('Weekly: 30%');
    });

    describe('monthly promotion', () => {
        const promotedContext: RenderContext = {
            usageData: {
                weeklyUsage: 10,
                weeklyResetAt: '2026-08-20T00:00:00.000Z',
                monthlyUsage: 55,
                monthlyResetAt: '2026-09-12T12:24:00.000Z'
            }
        };

        // These cover label and prefix handling, so drop the window entirely to
        // keep the pace delta out of the expectations.
        beforeEach(() => {
            vi.spyOn(usage, 'resolveMonthlyUsageWindow').mockReturnValue(null);
        });

        it('renders the monthly percent with the monthly label', () => {
            const widget = new WeeklyUsageWidget();

            expect(render(widget, {
                id: 'weekly',
                type: 'weekly-usage'
            }, promotedContext)).toBe('Monthly: 55%');
        });

        it('swaps a W prefix to M in raw-value mode', () => {
            const widget = new WeeklyUsageWidget();

            expect(render(widget, {
                id: 'weekly',
                type: 'weekly-usage',
                rawValue: true,
                metadata: { prefix: 'W ' }
            }, promotedContext)).toBe('M 55%');
        });

        it('leaves non-W prefixes untouched in raw-value mode', () => {
            const widget = new WeeklyUsageWidget();

            expect(render(widget, {
                id: 'weekly',
                type: 'weekly-usage',
                rawValue: true,
                metadata: { prefix: 'Quota ' }
            }, promotedContext)).toBe('Quota 55%');
        });

        it('uses the monthly window for the time cursor', () => {
            const widget = new WeeklyUsageWidget();
            const monthlyWindow: UsageWindowMetrics = {
                sessionDurationMs: 2592000000,
                elapsedMs: 1296000000,
                remainingMs: 1296000000,
                elapsedPercent: 25,
                remainingPercent: 75
            };
            const monthlyWindowSpy = vi.spyOn(usage, 'resolveMonthlyUsageWindow').mockReturnValue(monthlyWindow);
            const weeklyWindowSpy = vi.spyOn(usage, 'resolveWeeklyUsageWindow');

            const output = render(widget, {
                id: 'weekly',
                type: 'weekly-usage',
                metadata: { cursor: 'true', display: 'slider' }
            }, promotedContext);

            expect(monthlyWindowSpy).toHaveBeenCalled();
            expect(weeklyWindowSpy).not.toHaveBeenCalled();
            expect(output).toContain('Monthly: ');
        });

        it('keeps weekly rendering when monthly usage is lower', () => {
            const widget = new WeeklyUsageWidget();

            expect(render(widget, {
                id: 'weekly',
                type: 'weekly-usage',
                rawValue: true,
                metadata: { prefix: 'W ' }
            }, { usageData: { weeklyUsage: 55, monthlyUsage: 10 } })).toBe('W 55%');
        });
    });

    runUsagePercentWidgetSuite({
        baseItem: { id: 'weekly', type: 'weekly-usage' },
        createWidget: () => new WeeklyUsageWidget(),
        errorMessageMock: usageErrorMessageMock,
        expectedInvertedTime: 'Weekly: 57.9%',
        expectedModifierText: '(long bar, remaining)',
        expectedPreviewInvertedTime: 'Weekly: 88%',
        expectedProgress: 'Weekly: [███████████████████░░░░░░░░░░░░░] 57.9%',
        expectedRawInvertedTime: '57.9%',
        expectedRawProgress: '[███████░░░░░░░░░] 42.1%',
        expectedRawTime: '42.1%',
        expectedTime: 'Weekly: 42.1%',
        modifierItem: {
            id: 'weekly',
            type: 'weekly-usage',
            metadata: { display: 'progress', invert: 'true' }
        },
        progressItem: {
            id: 'weekly',
            type: 'weekly-usage',
            metadata: { display: 'progress', invert: 'true' }
        },
        rawProgressItem: {
            id: 'weekly',
            type: 'weekly-usage',
            rawValue: true,
            metadata: { display: 'progress-short' }
        },
        rawTimeItem: {
            id: 'weekly',
            type: 'weekly-usage',
            rawValue: true
        },
        render,
        usageField: 'weeklyUsage',
        usageValue: 42.06
    });
});
