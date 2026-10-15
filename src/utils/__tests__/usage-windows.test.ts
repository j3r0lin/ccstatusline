import {
    describe,
    expect,
    it
} from 'vitest';

import {
    getUsageErrorMessage,
    resolveUsageWindowWithFallback,
    shouldPromoteMonthlyUsage
} from '../usage-windows';

describe('getUsageErrorMessage', () => {
    it('returns the rate-limited label', () => {
        expect(getUsageErrorMessage('rate-limited')).toBe('[Rate limited]');
    });
});

describe('resolveUsageWindowWithFallback', () => {
    const blockMetrics = { startTime: new Date(Date.now() - 60 * 60 * 1000), lastActivity: new Date() };

    it('has no five-hour window when the provider reported usage without one', () => {
        expect(resolveUsageWindowWithFallback({ monthlyUsage: 20, monthlyResetAt: '2099-01-01T00:00:00Z' }, blockMetrics)).toBeNull();
    });

    it('falls back to the local block when the provider reported nothing', () => {
        expect(resolveUsageWindowWithFallback({}, blockMetrics)).not.toBeNull();
    });

    it('returns null for magpie with no account instead of the local transcript block', () => {
        expect(resolveUsageWindowWithFallback({ localBlockFallback: false }, blockMetrics)).toBeNull();
    });
});

describe('shouldPromoteMonthlyUsage', () => {
    it('promotes the monthly pool when the provider has no weekly window', () => {
        expect(shouldPromoteMonthlyUsage({ monthlyUsage: 20 })).toBe(true);
    });

    it('promotes the monthly pool even when the weekly percent is higher', () => {
        expect(shouldPromoteMonthlyUsage({ monthlyUsage: 20, weeklyUsage: 60 })).toBe(true);
    });

    it('does not promote when the provider reports no monthly pool', () => {
        expect(shouldPromoteMonthlyUsage({ weeklyUsage: 60 })).toBe(false);
    });
});

describe('resolveUsageWindowWithFallback with an idle five-hour window', () => {
    it('falls back to the local block when the five-hour window has no reset time', () => {
        const blockMetrics = { startTime: new Date(Date.now() - 60 * 60 * 1000), lastActivity: new Date() };
        expect(resolveUsageWindowWithFallback({ sessionUsage: 0, weeklyUsage: 84 }, blockMetrics)).not.toBeNull();
    });
});
