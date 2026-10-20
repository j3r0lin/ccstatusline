import {
    describe,
    expect,
    it
} from 'vitest';

import { SettingsSchema } from '../../../types/Settings';
import type { UsageWindowMetrics } from '../../../utils/usage-types';
import { getUsagePaceIndicator } from '../usage-pace';

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

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

describe('weekend weight', () => {
    // Window opens Thursday 2026-08-13 20:00 local, resets a week later.
    const RESET = '2026-08-20T20:00:00';
    const at = (iso: string) => new Date(iso).getTime();
    const paceAt = (percent: number, nowIso: string, weekendDays?: number) => getUsagePaceIndicator(percent, weeklyWindowAt(RESET, nowIso), weekendDays, at(nowIso));

    it('moves the baseline half as fast through Saturday and Sunday alike by default', () => {
        // Weighted hours of 144: Sat 00:00 has 28 (19.4%), Sun 00:00 adds 12
        // (27.8%), Mon 00:00 another 12 (36.1%).
        expect(paceAt(19, '2026-08-15T00:00:00', 1)?.text).toBe('▴0');
        expect(paceAt(28, '2026-08-16T00:00:00', 1)?.text).toBe('▴0');
        expect(paceAt(36, '2026-08-17T00:00:00', 1)?.text).toBe('▴0');
    });

    it('reaches 100% at the reset, leaving no buffer', () => {
        expect(paceAt(100, '2026-08-20T19:59:00', 1)?.text).toBe('▴0');
    });

    it('matches the wall clock at 2', () => {
        expect(paceAt(60, '2026-08-16T20:00:00', 2)).toEqual(getUsagePaceIndicator(60, weeklyWindowAt(RESET, '2026-08-16T20:00:00')));
    });

    it('holds the baseline flat over the weekend at 0', () => {
        expect(paceAt(20, '2026-08-15T01:00:00', 0)).toEqual(paceAt(20, '2026-08-16T23:00:00', 0));
    });

    it('leaves 5-hour and monthly windows on the wall clock', () => {
        const fiveHour = 5 * HOUR_MS;
        const month = 30 * 24 * HOUR_MS;
        const half = (d: number): UsageWindowMetrics => ({ sessionDurationMs: d, elapsedMs: d / 2, remainingMs: d / 2, elapsedPercent: 50, remainingPercent: 50 });
        expect(getUsagePaceIndicator(60, half(fiveHour), 0)?.text).toBe('▴10');
        expect(getUsagePaceIndicator(60, half(month), 0)?.text).toBe('▴10');
    });
});

describe('weekendDays setting', () => {
    it('defaults to 1 and falls back to 1 for invalid values', () => {
        expect(SettingsSchema.parse({}).weekendDays).toBe(1);
        expect(SettingsSchema.parse({ weekendDays: 0.5 }).weekendDays).toBe(0.5);
        for (const bad of [-1, 3, '1', null]) {
            expect(SettingsSchema.parse({ weekendDays: bad }).weekendDays).toBe(1);
        }
    });
});
