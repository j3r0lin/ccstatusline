import {
    describe,
    expect,
    it
} from 'vitest';

import type { UsageWindowMetrics } from '../../../utils/usage-types';
import { getUsagePaceIndicator } from '../usage-pace';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Builds the window a reset time implies, the same way resolveWeeklyUsageWindow
// does, so these cases read as "reset at X, now is Y".
function weeklyWindowAt(resetIso: string, nowIso: string): UsageWindowMetrics {
    const resetMs = new Date(resetIso).getTime();
    const nowMs = new Date(nowIso).getTime();
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

    it('measures progress on the wall clock, weekend included', () => {
        // Window opens Friday 03:00, now is Monday 15:00: half the week is gone.
        const window = weeklyWindowAt('2026-08-21T03:00:00', '2026-08-17T15:00:00');

        expect(window.elapsedPercent).toBeCloseTo(50, 5);
        expect(getUsagePaceIndicator(43, window)).toEqual({ color: 'brightGreen', text: '▾7' });
    });

    it('moves the baseline through Saturday and Sunday alike', () => {
        const reset = '2026-08-21T03:00:00';
        const saturday = getUsagePaceIndicator(21, weeklyWindowAt(reset, '2026-08-15T13:00:00'));
        const sunday = getUsagePaceIndicator(21, weeklyWindowAt(reset, '2026-08-16T13:00:00'));

        expect(sunday).not.toEqual(saturday);
    });

    it('colors reserve, deepening the further behind pace', () => {
        const window = weeklyWindowAt('2026-08-21T03:00:00', '2026-08-17T15:00:00');

        expect(getUsagePaceIndicator(48, window)).toEqual({ color: undefined, text: '▾2' });
        expect(getUsagePaceIndicator(41, window)).toEqual({ color: 'brightGreen', text: '▾9' });
        expect(getUsagePaceIndicator(10, window)).toEqual({ color: 'green', text: '▾40' });
    });

    it('leaves the narrow on-pace band uncolored', () => {
        const window = weeklyWindowAt('2026-08-21T03:00:00', '2026-08-17T15:00:00');

        expect(getUsagePaceIndicator(52, window)).toEqual({ color: undefined, text: '▴2' });
        expect(getUsagePaceIndicator(53, window)).toEqual({ color: 'yellow', text: '▴3' });
    });

    it('colors the deficit once spending runs meaningfully ahead', () => {
        const window = weeklyWindowAt('2026-08-21T03:00:00', '2026-08-17T15:00:00');

        expect(getUsagePaceIndicator(60, window)).toEqual({ color: 'yellow', text: '▴10' });
        expect(getUsagePaceIndicator(62, window)).toEqual({ color: 'yellow', text: '▴12' });
        expect(getUsagePaceIndicator(63, window)).toEqual({ color: 'brightRed', text: '▴13' });
    });

    it('says nothing when usage predates the window it is paced against', () => {
        const window = weeklyWindowAt('2026-08-24T10:00:00', '2026-08-17T10:00:00');

        expect(window.elapsedMs).toBe(0);
        expect(getUsagePaceIndicator(40, window)).toBeNull();
    });

    it('paces a monthly window on the wall clock too', () => {
        const monthMs = 30 * 24 * 60 * 60 * 1000;
        const elapsedMs = monthMs * 0.5;
        const window: UsageWindowMetrics = {
            sessionDurationMs: monthMs,
            elapsedMs,
            remainingMs: monthMs - elapsedMs,
            elapsedPercent: 50,
            remainingPercent: 50
        };

        expect(getUsagePaceIndicator(40, window)).toEqual({ color: 'brightGreen', text: '▾10' });
    });
});
