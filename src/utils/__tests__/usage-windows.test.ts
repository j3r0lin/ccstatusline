import {
    describe,
    expect,
    it
} from 'vitest';

import {
    getUsageErrorMessage,
    resolveUsageWindowWithFallback
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
});
