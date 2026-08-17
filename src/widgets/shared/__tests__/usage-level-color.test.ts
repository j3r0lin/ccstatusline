import {
    describe,
    expect,
    it
} from 'vitest';

import type { UsageWindowMetrics } from '../../../utils/usage-types';
import { getUsagePaceIndicator } from '../usage-level-color';

function windowAt(elapsedPercent: number): UsageWindowMetrics {
    const durationMs = 7 * 24 * 60 * 60 * 1000;
    const elapsedMs = (elapsedPercent / 100) * durationMs;

    return {
        sessionDurationMs: durationMs,
        elapsedMs,
        remainingMs: durationMs - elapsedMs,
        elapsedPercent,
        remainingPercent: 100 - elapsedPercent
    };
}

describe('getUsagePaceIndicator', () => {
    it('says nothing without a window to compare against', () => {
        expect(getUsagePaceIndicator(42)).toBeNull();
        expect(getUsagePaceIndicator(96, null)).toBeNull();
    });

    it('says nothing too early in the window for a delta to mean anything', () => {
        expect(getUsagePaceIndicator(40, windowAt(2))).toBeNull();
        expect(getUsagePaceIndicator(96, windowAt(2))).toBeNull();
    });

    it('reports reserve without color when spending is behind pace', () => {
        expect(getUsagePaceIndicator(21, windowAt(49))).toEqual({ color: undefined, text: '-28' });
        expect(getUsagePaceIndicator(30, windowAt(50))).toEqual({ color: undefined, text: '-20' });
    });

    it('reports a small deficit without color while still near pace', () => {
        expect(getUsagePaceIndicator(50, windowAt(50))).toEqual({ color: undefined, text: '+0' });
        expect(getUsagePaceIndicator(54, windowAt(50))).toEqual({ color: undefined, text: '+4' });
    });

    it('colors the deficit once spending runs meaningfully ahead', () => {
        expect(getUsagePaceIndicator(58, windowAt(50))).toEqual({ color: 'yellow', text: '+8' });
        expect(getUsagePaceIndicator(70, windowAt(50))).toEqual({ color: 'brightRed', text: '+20' });
    });

    it('reports reserve late in the window when spending was even', () => {
        expect(getUsagePaceIndicator(97, windowAt(96))).toEqual({ color: undefined, text: '+1' });
        expect(getUsagePaceIndicator(80, windowAt(96))).toEqual({ color: undefined, text: '-16' });
    });
});
