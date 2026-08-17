import {
    describe,
    expect,
    it
} from 'vitest';

import type { UsageWindowMetrics } from '../../../utils/usage-types';
import { getUsagePaceIndicator } from '../usage-pace';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Local time, so the weekday boundaries the pace baseline uses are unambiguous.
function at(iso: string): number {
    return new Date(iso).getTime();
}

// Builds the window a reset time implies, the same way resolveWeeklyUsageWindow
// does, so these cases read as "reset at X, now is Y".
function weeklyWindowAt(resetIso: string, nowIso: string): UsageWindowMetrics {
    const resetMs = at(resetIso);
    const nowMs = at(nowIso);
    const elapsedMs = Math.max(0, Math.min(nowMs - (resetMs - WEEK_MS), WEEK_MS));

    return {
        sessionDurationMs: WEEK_MS,
        elapsedMs,
        remainingMs: WEEK_MS - elapsedMs,
        elapsedPercent: (elapsedMs / WEEK_MS) * 100,
        remainingPercent: 100 - (elapsedMs / WEEK_MS) * 100
    };
}

describe('getUsagePaceIndicator', () => {
    it('says nothing without a window to compare against', () => {
        expect(getUsagePaceIndicator(42)).toBeNull();
        expect(getUsagePaceIndicator(96, null)).toBeNull();
    });

    it('measures progress in workdays, not wall clock', () => {
        // Window opens Friday 03:00, now is Monday 13:00: 34 of the window's
        // 120 workday hours have passed (28%), while 49% of the week has.
        const now = '2026-08-17T13:00:00';
        const window = weeklyWindowAt('2026-08-21T03:00:00', now);

        expect(window.elapsedPercent).toBeCloseTo(48.8, 0);
        expect(getUsagePaceIndicator(21, window, at(now))).toEqual({ color: 'brightGreen', text: '-7%' });
    });

    it('does not count the weekend against you', () => {
        // The window opens Friday; Saturday and Sunday add no workday time, so
        // a day of not working does not move the delta.
        const reset = '2026-08-21T03:00:00';
        const saturday = '2026-08-15T13:00:00';
        const sunday = '2026-08-16T13:00:00';

        expect(getUsagePaceIndicator(21, weeklyWindowAt(reset, sunday), at(sunday)))
            .toEqual(getUsagePaceIndicator(21, weeklyWindowAt(reset, saturday), at(saturday)));
    });

    it('colors reserve, deepening the further behind pace', () => {
        const now = '2026-08-19T12:00:00'; // Wednesday, 67% of workdays elapsed
        const window = weeklyWindowAt('2026-08-21T03:00:00', now);

        expect(getUsagePaceIndicator(61, window, at(now))).toEqual({ color: undefined, text: '-6%' });
        expect(getUsagePaceIndicator(58, window, at(now))).toEqual({ color: 'brightGreen', text: '-9%' });
        expect(getUsagePaceIndicator(10, window, at(now))).toEqual({ color: 'green', text: '-57%' });
    });

    it('leaves a small deficit uncolored', () => {
        const now = '2026-08-17T13:00:00'; // Monday, 28% of workdays elapsed
        const window = weeklyWindowAt('2026-08-21T03:00:00', now);

        expect(getUsagePaceIndicator(34, window, at(now))).toEqual({ color: undefined, text: '+6%' });
    });

    it('colors the deficit once spending runs meaningfully ahead', () => {
        const now = '2026-08-17T13:00:00'; // Monday, 28% of workdays elapsed
        const window = weeklyWindowAt('2026-08-21T03:00:00', now);

        expect(getUsagePaceIndicator(38, window, at(now))).toEqual({ color: 'yellow', text: '+10%' });
        expect(getUsagePaceIndicator(40, window, at(now))).toEqual({ color: 'yellow', text: '+12%' });
        expect(getUsagePaceIndicator(41, window, at(now))).toEqual({ color: 'brightRed', text: '+13%' });
    });

    it('says nothing when usage predates the window it is paced against', () => {
        const now = '2026-08-17T10:00:00';
        const window = weeklyWindowAt('2026-08-24T10:00:00', now);

        expect(window.elapsedMs).toBe(0);
        expect(getUsagePaceIndicator(40, window, at(now))).toBeNull();
    });

    it('paces a monthly window on wall clock, not workdays', () => {
        const monthMs = 30 * 24 * 60 * 60 * 1000;
        const now = at('2026-08-17T13:00:00');
        const elapsedMs = monthMs * 0.5;
        const window: UsageWindowMetrics = {
            sessionDurationMs: monthMs,
            elapsedMs,
            remainingMs: monthMs - elapsedMs,
            elapsedPercent: 50,
            remainingPercent: 50
        };

        expect(getUsagePaceIndicator(40, window, now)).toEqual({ color: 'brightGreen', text: '-10%' });
    });
});
