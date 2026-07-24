import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { RenderContext } from '../../types/RenderContext';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import type { WidgetItem } from '../../types/Widget';
import * as usage from '../../utils/usage';
import type { UsageWindowMetrics } from '../../utils/usage-types';
import {
    SessionUsageWidget,
    resolveSessionUsageDisplaySource
} from '../SessionUsage';

import { runUsagePercentWidgetSuite } from './helpers/usage-widget-suites';

let mockGetUsageErrorMessage: { mockReturnValue: (value: string) => void };
const usageErrorMessageMock = {
    mockReturnValue(value: string): void {
        mockGetUsageErrorMessage.mockReturnValue(value);
    }
};

const halfElapsedWindow: UsageWindowMetrics = {
    sessionDurationMs: 18000000,
    elapsedMs: 9000000,
    remainingMs: 9000000,
    elapsedPercent: 50,
    remainingPercent: 50
};

function render(widget: SessionUsageWidget, item: WidgetItem, context: RenderContext = {}): string | null {
    return widget.render(item, context, DEFAULT_SETTINGS);
}

describe('SessionUsageWidget', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mockGetUsageErrorMessage = vi.spyOn(usage, 'getUsageErrorMessage');
        // makeUsageProgressBar no longer used; SessionUsage uses makeTimerProgressBar directly
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the time cursor in short bar modes', () => {
        const widget = new SessionUsageWidget();
        const context: RenderContext = { usageData: { sessionUsage: 20 } };

        vi.spyOn(usage, 'resolveUsageWindowWithFallback').mockReturnValue(halfElapsedWindow);

        expect(render(widget, {
            id: 'session',
            type: 'session-usage',
            metadata: { cursor: 'true', display: 'slider' }
        }, context)).toBe('Session: ▓▓░░░│░░░░ 20.0%');
        expect(render(widget, {
            id: 'session',
            type: 'session-usage',
            metadata: { cursor: 'true', display: 'slider-only' }
        }, context)).toBe('Session: ▓▓░░░│░░░░');
    });

    it('promotes weekly usage into the session slot when session usage is absent', () => {
        const widget = new SessionUsageWidget();
        vi.spyOn(usage, 'resolveWeeklyUsageWindow').mockReturnValue(halfElapsedWindow);

        expect(render(widget, {
            id: 'session',
            type: 'session-usage',
            metadata: { cursor: 'true', display: 'slider' }
        }, { usageData: { weeklyUsage: 30, weeklyResetAt: '2030-01-07T00:00:00Z' } })).toBe('Weekly: ▓▓▓░░│░░░░ 30.0%');
    });

    it('prefers session usage over weekly usage when both are present', () => {
        const widget = new SessionUsageWidget();

        expect(render(widget, {
            id: 'session',
            type: 'session-usage',
            metadata: { display: 'slider' }
        }, { usageData: { sessionUsage: 12, weeklyUsage: 90 } })).toBe('Session: ▓░░░░░░░░░ 12.0%');
    });

    it('treats zero session usage as present and does not promote weekly', () => {
        const widget = new SessionUsageWidget();

        expect(render(widget, {
            id: 'session',
            type: 'session-usage'
        }, { usageData: { sessionUsage: 0, weeklyUsage: 90 } })).toBe('Session: 0.0%');
    });

    it('still surfaces usage errors when neither session nor weekly usage is available', () => {
        const widget = new SessionUsageWidget();
        mockGetUsageErrorMessage.mockReturnValue('No credentials');

        expect(render(widget, {
            id: 'session',
            type: 'session-usage'
        }, { usageData: { error: 'no-credentials' } })).toBe('No credentials');
    });

    describe('resolveSessionUsageDisplaySource', () => {
        it('returns session usage without promotion when present', () => {
            expect(resolveSessionUsageDisplaySource({ sessionUsage: 10, weeklyUsage: 50 })).toEqual({
                percent: 10,
                promoted: false
            });
        });

        it('promotes weekly usage only when session usage is missing', () => {
            expect(resolveSessionUsageDisplaySource({ weeklyUsage: 37.5 })).toEqual({
                percent: 37.5,
                promoted: true
            });
        });

        it('returns null when no fillable usage is available', () => {
            expect(resolveSessionUsageDisplaySource({})).toBeNull();
            expect(resolveSessionUsageDisplaySource({ error: 'timeout' })).toBeNull();
        });
    });

    runUsagePercentWidgetSuite({
        baseItem: { id: 'session', type: 'session-usage' },
        createWidget: () => new SessionUsageWidget(),
        errorMessageMock: usageErrorMessageMock,
        expectedInvertedTime: 'Session: 76.5%',
        expectedModifierText: '(medium bar, remaining)',
        expectedPreviewInvertedTime: 'Session: 80.0%',
        expectedProgress: 'Session: [████████████░░░░] 76.5%',
        expectedRawInvertedTime: '76.5%',
        expectedRawProgress: '[████████░░░░░░░░░░░░░░░░░░░░░░░░] 23.4%',
        expectedRawTime: '23.4%',
        expectedTime: 'Session: 23.4%',
        modifierItem: {
            id: 'session',
            type: 'session-usage',
            metadata: { display: 'progress-short', invert: 'true' }
        },
        progressItem: {
            id: 'session',
            type: 'session-usage',
            metadata: { display: 'progress-short', invert: 'true' }
        },
        rawProgressItem: {
            id: 'session',
            type: 'session-usage',
            rawValue: true,
            metadata: { display: 'progress' }
        },
        rawTimeItem: {
            id: 'session',
            type: 'session-usage',
            rawValue: true
        },
        render,
        usageField: 'sessionUsage',
        usageValue: 23.45
    });
});
