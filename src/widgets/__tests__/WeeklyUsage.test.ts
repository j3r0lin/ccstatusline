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

        expect(render(widget, {
            id: 'weekly',
            type: 'weekly-usage',
            metadata: { cursor: 'true', display: 'slider' }
        }, context)).toBe('Weekly: ▓▓░░░│░░░░ 20.0%');
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

        it('shows reserve as an uncolored negative delta', () => {
            const context: RenderContext = { usageData: { weeklyUsage: 55 } };

            vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(windowAt(90));

            const output = renderColored(item, context);
            expect(output).toBe('Weekly: 55.0% -35');
            expect(output).toBe(stripSgrCodes(output ?? ''));
        });

        it('appends the delta when spending runs ahead', () => {
            const context: RenderContext = { usageData: { weeklyUsage: 55 } };

            vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(windowAt(20));

            const output = renderColored(item, context) ?? '';
            expect(stripSgrCodes(output)).toBe('Weekly: 55.0% +35');
        });

        it('says nothing at all too early in the window', () => {
            const context: RenderContext = { usageData: { weeklyUsage: 55 } };

            vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(windowAt(2));

            expect(renderColored(item, context)).toBe('Weekly: 55.0%');
        });

        it('colors only the delta, leaving the percent plain', () => {
            const context: RenderContext = { usageData: { weeklyUsage: 55 } };

            vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(windowAt(20));

            const output = renderColored(item, context) ?? '';
            expect(output.startsWith('Weekly: 55.0% ')).toBe(true);
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
            expect(renderColored(item, context)).toBe('Monthly: 55.0% -35');

            vi.spyOn(usage, 'resolveMonthlyUsageWindow').mockReturnValue(windowAt(20));
            expect(stripSgrCodes(renderColored(item, context) ?? '')).toBe('Monthly: 55.0% +35');
        });

        it('leaves the percent alone so the configured color still applies', () => {
            const context: RenderContext = { usageData: { weeklyUsage: 55 } };
            const explicit: WidgetItem = { ...item, color: 'brightBlue' };

            vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(windowAt(20));

            expect(renderColored(explicit, context)).toBe(renderColored(item, context));
        });

        it('omits the delta in bar modes, where the cursor already shows pace', () => {
            const context: RenderContext = { usageData: { weeklyUsage: 55 } };
            const barItem: WidgetItem = { ...item, metadata: { display: 'slider' } };

            vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(windowAt(20));

            expect(renderColored(barItem, context)).not.toContain('+35');
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
        })).toBe('Weekly: 30.0%');
    });

    it('still renders weekly alone when session-usage is not configured', () => {
        const widget = new WeeklyUsageWidget();

        expect(render(widget, {
            id: 'weekly',
            type: 'weekly-usage'
        }, {
            hasSessionUsageWidget: false,
            usageData: { weeklyUsage: 30 }
        })).toBe('Weekly: 30.0%');
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
            }, promotedContext)).toBe('Monthly: 55.0%');
        });

        it('swaps a W prefix to M in raw-value mode', () => {
            const widget = new WeeklyUsageWidget();

            expect(render(widget, {
                id: 'weekly',
                type: 'weekly-usage',
                rawValue: true,
                metadata: { prefix: 'W ' }
            }, promotedContext)).toBe('M 55.0%');
        });

        it('leaves non-W prefixes untouched in raw-value mode', () => {
            const widget = new WeeklyUsageWidget();

            expect(render(widget, {
                id: 'weekly',
                type: 'weekly-usage',
                rawValue: true,
                metadata: { prefix: 'Quota ' }
            }, promotedContext)).toBe('Quota 55.0%');
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
            }, { usageData: { weeklyUsage: 55, monthlyUsage: 10 } })).toBe('W 55.0%');
        });
    });

    runUsagePercentWidgetSuite({
        baseItem: { id: 'weekly', type: 'weekly-usage' },
        createWidget: () => new WeeklyUsageWidget(),
        errorMessageMock: usageErrorMessageMock,
        expectedInvertedTime: 'Weekly: 57.9%',
        expectedModifierText: '(long bar, remaining)',
        expectedPreviewInvertedTime: 'Weekly: 88.0%',
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
