import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { WidgetItem } from '../../types/Widget';
import * as codexUsage from '../codex-usage';
import * as grokUsage from '../grok-usage';
import * as kimiUsage from '../kimi-usage';
import * as usage from '../usage';
import {
    extractUsageDataFromRateLimits,
    hasUsageDependentWidgets,
    prefetchUsageDataIfNeeded
} from '../usage-prefetch';
import type { UsageData } from '../usage-types';

function makeLines(...lineItems: WidgetItem[][]): WidgetItem[][] {
    return lineItems;
}

function epochToIso(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toISOString();
}

describe('usage prefetch', () => {
    let mockFetchUsageData: {
        mock: { calls: unknown[][] };
        mockResolvedValue: (value: UsageData) => void;
    };
    let mockFetchKimiUsageData: {
        mock: { calls: unknown[][] };
        mockResolvedValue: (value: UsageData) => void;
    };
    let mockFetchGrokUsageData: {
        mock: { calls: unknown[][] };
        mockResolvedValue: (value: UsageData) => void;
    };
    let mockFetchCodexUsageData: {
        mock: { calls: unknown[][] };
        mockResolvedValue: (value: UsageData) => void;
    };
    let originalAnthropicModel: string | undefined;
    let originalAnthropicHaikuModel: string | undefined;
    let originalAnthropicSonnetModel: string | undefined;
    let originalAnthropicOpusModel: string | undefined;
    let originalAnthropicBaseUrl: string | undefined;

    beforeEach(() => {
        vi.restoreAllMocks();
        // Prefetch falls back to process env when status model is absent; isolate from the host shell.
        originalAnthropicModel = process.env.ANTHROPIC_MODEL;
        originalAnthropicHaikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
        originalAnthropicSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
        originalAnthropicOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
        originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
        delete process.env.ANTHROPIC_MODEL;
        delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
        delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
        delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
        delete process.env.ANTHROPIC_BASE_URL;
        mockFetchUsageData = vi.spyOn(usage, 'fetchUsageData');
        mockFetchKimiUsageData = vi.spyOn(kimiUsage, 'fetchKimiUsageData');
        mockFetchGrokUsageData = vi.spyOn(grokUsage, 'fetchGrokUsageData');
        mockFetchCodexUsageData = vi.spyOn(codexUsage, 'fetchCodexUsageData');
    });

    afterEach(() => {
        if (originalAnthropicModel === undefined) {
            delete process.env.ANTHROPIC_MODEL;
        } else {
            process.env.ANTHROPIC_MODEL = originalAnthropicModel;
        }
        if (originalAnthropicHaikuModel === undefined) {
            delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
        } else {
            process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = originalAnthropicHaikuModel;
        }
        if (originalAnthropicSonnetModel === undefined) {
            delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
        } else {
            process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = originalAnthropicSonnetModel;
        }
        if (originalAnthropicOpusModel === undefined) {
            delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
        } else {
            process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = originalAnthropicOpusModel;
        }
        if (originalAnthropicBaseUrl === undefined) {
            delete process.env.ANTHROPIC_BASE_URL;
        } else {
            process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
        }
        vi.restoreAllMocks();
    });

    it.each([
        {
            expected: true,
            lines: makeLines(
                [{ id: '1', type: 'model' }],
                [{ id: '2', type: 'block-timer' }]
            ),
            name: 'detects when usage widgets are present'
        },
        {
            expected: true,
            lines: makeLines(
                [{ id: '1', type: 'model' }],
                [{ id: '2', type: 'extra-usage-remaining' }]
            ),
            name: 'detects when extra usage widgets are present'
        },
        {
            expected: false,
            lines: makeLines(
                [{ id: '1', type: 'model' }],
                [{ id: '2', type: 'git-branch' }]
            ),
            name: 'does not detect usage requirement for non-usage widgets'
        }
    ])('$name', ({ expected, lines }) => {
        expect(hasUsageDependentWidgets(lines)).toBe(expected);
    });

    it('fetches usage data once when at least one usage widget exists', async () => {
        mockFetchUsageData.mockResolvedValue({ sessionUsage: 12.3 });

        const lines = makeLines(
            [{ id: '1', type: 'model' }],
            [{ id: '2', type: 'session-usage' }, { id: '3', type: 'weekly-usage' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines);

        expect(usageData).toEqual({ sessionUsage: 12.3 });
        expect(mockFetchUsageData.mock.calls.length).toBe(1);
    });

    it('does not fetch usage data when no usage widgets exist', async () => {
        const lines = makeLines(
            [{ id: '1', type: 'model' }],
            [{ id: '2', type: 'git-branch' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines);

        expect(usageData).toBeNull();
        expect(mockFetchUsageData.mock.calls.length).toBe(0);
    });

    it('uses rate_limits from StatusJSON instead of fetching from API', async () => {
        mockFetchUsageData.mockResolvedValue({ sessionUsage: 99 });

        const lines = makeLines(
            [{ id: '1', type: 'session-usage' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, {
            rate_limits: {
                five_hour: { used_percentage: 42, resets_at: 1774020000 },
                seven_day: { used_percentage: 15, resets_at: 1774540000 }
            }
        });

        expect(usageData?.sessionUsage).toBe(42);
        expect(usageData?.weeklyUsage).toBe(15);
        expect(mockFetchUsageData.mock.calls.length).toBe(0);
    });

    it('falls back to API fetch when rate_limits is absent', async () => {
        mockFetchUsageData.mockResolvedValue({ sessionUsage: 42 });

        const lines = makeLines(
            [{ id: '1', type: 'session-usage' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, {});

        expect(usageData).toEqual({ sessionUsage: 42 });
        expect(mockFetchUsageData.mock.calls.length).toBe(1);
    });

    it('uses Kimi Code usage when the active model is Kimi', async () => {
        mockFetchKimiUsageData.mockResolvedValue({
            sessionUsage: 25,
            sessionResetAt: '2030-01-01T05:00:00Z',
            weeklyUsage: 50,
            weeklyResetAt: '2030-01-07T00:00:00Z'
        });

        const lines = makeLines(
            [{ id: '1', type: 'session-usage' }, { id: '2', type: 'weekly-usage' }]
        );
        const usageData = await prefetchUsageDataIfNeeded(lines, {
            model: { id: 'kimi-k2.5' },
            rate_limits: {
                five_hour: { used_percentage: 99 },
                seven_day: { used_percentage: 99 }
            }
        });

        expect(usageData?.sessionUsage).toBe(25);
        expect(usageData?.weeklyUsage).toBe(50);
        expect(mockFetchKimiUsageData.mock.calls).toEqual([
            [{ requiredFields: ['sessionUsage', 'weeklyUsage', 'monthlyUsage'] }]
        ]);
        expect(mockFetchGrokUsageData.mock.calls.length).toBe(0);
        expect(mockFetchUsageData.mock.calls.length).toBe(0);
    });

    it('uses Grok web billing when the active model is Grok', async () => {
        mockFetchGrokUsageData.mockResolvedValue({
            weeklyUsage: 37.5,
            weeklyResetAt: '2030-01-07T00:00:00Z'
        });

        const lines = makeLines(
            [{ id: '1', type: 'weekly-usage' }, { id: '2', type: 'weekly-reset-timer' }]
        );
        const usageData = await prefetchUsageDataIfNeeded(lines, {
            model: { id: 'grok-code' },
            rate_limits: {
                five_hour: { used_percentage: 99 },
                seven_day: { used_percentage: 99 }
            }
        });

        expect(usageData).toEqual({
            weeklyUsage: 37.5,
            weeklyResetAt: '2030-01-07T00:00:00Z'
        });
        expect(mockFetchGrokUsageData.mock.calls).toEqual([
            [{ requiredFields: ['weeklyUsage', 'weeklyResetAt'] }]
        ]);
        expect(mockFetchKimiUsageData.mock.calls.length).toBe(0);
        expect(mockFetchCodexUsageData.mock.calls.length).toBe(0);
        expect(mockFetchUsageData.mock.calls.length).toBe(0);
    });

    it('uses Codex wham usage when the active model is Codex', async () => {
        mockFetchCodexUsageData.mockResolvedValue({
            sessionUsage: 42,
            sessionResetAt: '2030-01-01T00:00:00.000Z',
            weeklyUsage: 15,
            weeklyResetAt: '2030-01-08T00:00:00.000Z'
        });

        const lines = makeLines(
            [{ id: '1', type: 'session-usage' }, { id: '2', type: 'weekly-usage' }]
        );
        const usageData = await prefetchUsageDataIfNeeded(lines, {
            model: { id: 'gpt-5.3-codex' },
            rate_limits: {
                five_hour: { used_percentage: 99 },
                seven_day: { used_percentage: 99 }
            }
        });

        expect(usageData).toEqual({
            sessionUsage: 42,
            sessionResetAt: '2030-01-01T00:00:00.000Z',
            weeklyUsage: 15,
            weeklyResetAt: '2030-01-08T00:00:00.000Z'
        });
        expect(mockFetchCodexUsageData.mock.calls).toEqual([
            [{ requiredFields: ['sessionUsage', 'weeklyUsage'] }]
        ]);
        expect(mockFetchKimiUsageData.mock.calls.length).toBe(0);
        expect(mockFetchGrokUsageData.mock.calls.length).toBe(0);
        expect(mockFetchUsageData.mock.calls.length).toBe(0);
    });

    it('merges reset-only rate_limits data with API usage data', async () => {
        mockFetchUsageData.mockResolvedValue({ sessionUsage: 42 });

        const lines = makeLines(
            [{ id: '1', type: 'session-usage' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, { rate_limits: { five_hour: { resets_at: 1774020000 } } });

        expect(usageData).toEqual({
            sessionUsage: 42,
            sessionResetAt: epochToIso(1774020000)
        });
        expect(mockFetchUsageData.mock.calls.length).toBe(1);
    });

    it('merges API weekly data under partial statusline data', async () => {
        mockFetchUsageData.mockResolvedValue({
            sessionUsage: 99,
            sessionResetAt: '2026-03-20T12:00:00.000Z',
            weeklyUsage: 10,
            weeklyResetAt: '2026-03-27T12:00:00.000Z'
        });

        const lines = makeLines(
            [{ id: '1', type: 'weekly-usage' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, { rate_limits: { five_hour: { used_percentage: 50, resets_at: 1774020000 } } });

        expect(usageData).toEqual({
            sessionUsage: 50,
            sessionResetAt: epochToIso(1774020000),
            weeklyUsage: 10,
            weeklyResetAt: '2026-03-27T12:00:00.000Z'
        });
        expect(mockFetchUsageData.mock.calls.length).toBe(1);
    });

    it('uses per-model rate_limits buckets when a per-model widget is present', async () => {
        mockFetchUsageData.mockResolvedValue({ sessionUsage: 99 });

        const lines = makeLines(
            [{ id: '1', type: 'weekly-sonnet-usage' }, { id: '2', type: 'weekly-opus-usage' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, {
            rate_limits: {
                five_hour: { used_percentage: 42, resets_at: 1774020000 },
                seven_day: { used_percentage: 15, resets_at: 1774540000 },
                seven_day_sonnet: { used_percentage: 8, resets_at: 1774540001 },
                seven_day_opus: { used_percentage: 2, resets_at: 1774540002 }
            }
        });

        expect(usageData?.weeklySonnetUsage).toBe(8);
        expect(usageData?.weeklyOpusUsage).toBe(2);
        expect(usageData?.weeklySonnetResetAt).toBe(new Date(1774540001 * 1000).toISOString());
        expect(usageData?.weeklyOpusResetAt).toBe(new Date(1774540002 * 1000).toISOString());
        expect(mockFetchUsageData.mock.calls.length).toBe(0);
    });

    it('falls back to API fetch when per-model widget is present but rate_limits lacks per-model buckets', async () => {
        mockFetchUsageData.mockResolvedValue({
            sessionUsage: 42,
            sessionResetAt: '2026-03-20T12:00:00.000Z',
            weeklyUsage: 15,
            weeklyResetAt: '2026-03-27T12:00:00.000Z',
            weeklySonnetUsage: 8,
            weeklySonnetResetAt: '2026-03-27T12:00:00.000Z'
        });

        const lines = makeLines(
            [{ id: '1', type: 'weekly-sonnet-usage' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, {
            rate_limits: {
                five_hour: { used_percentage: 42, resets_at: 1774020000 },
                seven_day: { used_percentage: 15, resets_at: 1774540000 }
            }
        });

        expect(usageData?.weeklySonnetUsage).toBe(8);
        expect(usageData?.sessionUsage).toBe(42);
        expect(usageData?.sessionResetAt).toBe(epochToIso(1774020000));
        expect(usageData?.weeklyUsage).toBe(15);
        expect(usageData?.weeklyResetAt).toBe(epochToIso(1774540000));
        expect(mockFetchUsageData.mock.calls.length).toBe(1);
    });

    it.each([
        {
            apiUsageData: { weeklySonnetUsage: 8 },
            bucketName: 'seven_day_sonnet' as const,
            expectedUsage: 8,
            usageField: 'weeklySonnetUsage' as const,
            widgetType: 'weekly-sonnet-usage'
        },
        {
            apiUsageData: { weeklyOpusUsage: 2 },
            bucketName: 'seven_day_opus' as const,
            expectedUsage: 2,
            usageField: 'weeklyOpusUsage' as const,
            widgetType: 'weekly-opus-usage'
        }
    ])('falls back to API fetch when $widgetType has only a reset timestamp in rate_limits', async ({
        apiUsageData,
        bucketName,
        expectedUsage,
        usageField,
        widgetType
    }) => {
        mockFetchUsageData.mockResolvedValue({
            sessionUsage: 42,
            sessionResetAt: '2026-03-20T12:00:00.000Z',
            weeklyUsage: 15,
            weeklyResetAt: '2026-03-27T12:00:00.000Z',
            ...apiUsageData
        });

        const lines = makeLines(
            [{ id: '1', type: widgetType }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, {
            rate_limits: {
                five_hour: { used_percentage: 42, resets_at: 1774020000 },
                seven_day: { used_percentage: 15, resets_at: 1774540000 },
                [bucketName]: { resets_at: 1774540001 }
            }
        });

        expect(usageData?.[usageField]).toBe(expectedUsage);
        expect(usageData?.weeklySonnetResetAt ?? usageData?.weeklyOpusResetAt).toBe(epochToIso(1774540001));
        expect(mockFetchUsageData.mock.calls.length).toBe(1);
    });

    it('uses reset-only rate_limits data without fetching for reset timer widgets', async () => {
        mockFetchUsageData.mockResolvedValue({ error: 'no-credentials' });

        const lines = makeLines(
            [{ id: '1', type: 'reset-timer' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, { rate_limits: { five_hour: { resets_at: 1774020000 } } });

        expect(usageData).toEqual({ sessionResetAt: epochToIso(1774020000) });
        expect(mockFetchUsageData.mock.calls.length).toBe(0);
    });

    it('suppresses API errors when reset timer widgets are only missing reset data', async () => {
        mockFetchUsageData.mockResolvedValue({ error: 'rate-limited' });

        const lines = makeLines(
            [{ id: '1', type: 'reset-timer' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, {
            rate_limits: {
                five_hour: { used_percentage: 42 },
                seven_day: { used_percentage: 15, resets_at: 1774540000 }
            }
        });

        expect(usageData).toEqual({
            sessionUsage: 42,
            weeklyUsage: 15,
            weeklyResetAt: epochToIso(1774540000)
        });
        expect(mockFetchUsageData.mock.calls).toEqual([
            [{ requiredFields: ['sessionResetAt'] }]
        ]);
    });

    it('returns no usage data instead of a rate-limit error for reset-only startup fetches', async () => {
        mockFetchUsageData.mockResolvedValue({ error: 'rate-limited' });

        const lines = makeLines(
            [{ id: '1', type: 'weekly-reset-timer' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, {});

        expect(usageData).toBeNull();
        expect(mockFetchUsageData.mock.calls).toEqual([
            [{ requiredFields: ['weeklyResetAt'] }]
        ]);
    });

    it('keeps statusline usage when cursor metadata requires a missing reset and API has no credentials', async () => {
        mockFetchUsageData.mockResolvedValue({ error: 'no-credentials' });

        const lines = makeLines(
            [{ id: '1', type: 'session-usage', metadata: { cursor: 'true' } }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, { rate_limits: { five_hour: { used_percentage: 42 } } });

        expect(usageData).toEqual({
            sessionUsage: 42,
            error: 'no-credentials'
        });
        expect(mockFetchUsageData.mock.calls.length).toBe(1);
    });

    it('preserves API errors when statusline data is partial and fetch fails', async () => {
        mockFetchUsageData.mockResolvedValue({ error: 'no-credentials' });

        const lines = makeLines(
            [{ id: '1', type: 'session-usage' }, { id: '2', type: 'weekly-sonnet-usage' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, { rate_limits: { five_hour: { used_percentage: 42 } } });

        expect(usageData).toEqual({
            sessionUsage: 42,
            error: 'no-credentials'
        });
        expect(mockFetchUsageData.mock.calls.length).toBe(1);
        expect(mockFetchUsageData.mock.calls[0]).toEqual([{ requiredFields: ['weeklySonnetUsage'] }]);
    });

    it('preserves API errors when statusline data has no usable usage fields', async () => {
        mockFetchUsageData.mockResolvedValue({ error: 'no-credentials' });

        const lines = makeLines(
            [{ id: '1', type: 'session-usage' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, { rate_limits: {} });

        expect(usageData).toEqual({ error: 'no-credentials' });
        expect(mockFetchUsageData.mock.calls.length).toBe(1);
    });

    it('uses aggregate weekly reset as the per-model cursor fallback without fetching for reset data', async () => {
        mockFetchUsageData.mockResolvedValue({ weeklySonnetUsage: 8 });

        const lines = makeLines(
            [{ id: '1', type: 'weekly-sonnet-usage', metadata: { cursor: 'true' } }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, { rate_limits: { seven_day: { resets_at: 1774540000 } } });

        expect(usageData).toEqual({
            weeklyResetAt: epochToIso(1774540000),
            weeklySonnetUsage: 8
        });
        expect(mockFetchUsageData.mock.calls.length).toBe(1);
        expect(mockFetchUsageData.mock.calls[0]).toEqual([{ requiredFields: ['weeklySonnetUsage'] }]);
    });

    it('fetches extra usage fields while preserving statusline usage data', async () => {
        mockFetchUsageData.mockResolvedValue({
            extraUsageEnabled: true,
            extraUsageLimit: 400000,
            extraUsageUsed: 10600,
            extraUsageUtilization: 2.6
        });

        const lines = makeLines(
            [{ id: '1', type: 'extra-usage-utilization' }, { id: '2', type: 'extra-usage-remaining' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, { rate_limits: { five_hour: { used_percentage: 42 } } });

        expect(usageData).toEqual({
            sessionUsage: 42,
            extraUsageEnabled: true,
            extraUsageLimit: 400000,
            extraUsageUsed: 10600,
            extraUsageUtilization: 2.6
        });
        expect(mockFetchUsageData.mock.calls).toEqual([
            [{
                requiredFields: [
                    'extraUsageEnabled',
                    'extraUsageUtilization',
                    'extraUsageLimit',
                    'extraUsageUsed'
                ]
            }]
        ]);
    });

    it('preserves API errors when extra usage fields are missing', async () => {
        mockFetchUsageData.mockResolvedValue({ error: 'no-credentials' });

        const lines = makeLines(
            [{ id: '1', type: 'session-usage' }, { id: '2', type: 'extra-usage-remaining' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, { rate_limits: { five_hour: { used_percentage: 42 } } });

        expect(usageData).toEqual({
            sessionUsage: 42,
            error: 'no-credentials'
        });
        expect(mockFetchUsageData.mock.calls).toEqual([
            [{
                requiredFields: [
                    'extraUsageEnabled',
                    'extraUsageLimit',
                    'extraUsageUsed'
                ]
            }]
        ]);
    });

    it('does not require per-model buckets when only the all-models weekly widget is present', async () => {
        const lines = makeLines(
            [{ id: '1', type: 'weekly-usage' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, {
            rate_limits: {
                five_hour: { used_percentage: 42, resets_at: 1774020000 },
                seven_day: { used_percentage: 15, resets_at: 1774540000 }
            }
        });

        expect(usageData?.weeklyUsage).toBe(15);
        expect(mockFetchUsageData.mock.calls.length).toBe(0);
    });

    it('treats null requested per-model buckets as zero usage without fetching', async () => {
        const lines = makeLines(
            [{ id: '1', type: 'weekly-sonnet-usage' }, { id: '2', type: 'weekly-opus-usage' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, {
            rate_limits: {
                five_hour: { used_percentage: 42, resets_at: 1774020000 },
                seven_day: { used_percentage: 15, resets_at: 1774540000 },
                seven_day_sonnet: null,
                seven_day_opus: null
            }
        });

        expect(usageData?.weeklySonnetUsage).toBe(0);
        expect(usageData?.weeklyOpusUsage).toBe(0);
        expect(mockFetchUsageData.mock.calls.length).toBe(0);
    });

    it('falls back to API fetch when sessionResetAt is missing from rate_limits', async () => {
        mockFetchUsageData.mockResolvedValue({
            sessionUsage: 42,
            sessionResetAt: '2026-03-20T12:00:00.000Z',
            weeklyUsage: 15,
            weeklyResetAt: '2026-03-27T12:00:00.000Z'
        });

        const lines = makeLines(
            [{ id: '1', type: 'reset-timer' }]
        );

        const usageData = await prefetchUsageDataIfNeeded(lines, {
            rate_limits: {
                five_hour: { used_percentage: 42 },
                seven_day: { used_percentage: 15, resets_at: 1774540000 }
            }
        });

        expect(usageData).toEqual({
            sessionUsage: 42,
            sessionResetAt: '2026-03-20T12:00:00.000Z',
            weeklyUsage: 15,
            weeklyResetAt: epochToIso(1774540000)
        });
        expect(mockFetchUsageData.mock.calls.length).toBe(1);
    });
});

describe('extractUsageDataFromRateLimits', () => {
    it('extracts session and weekly usage from rate_limits', () => {
        const result = extractUsageDataFromRateLimits({
            five_hour: { used_percentage: 42, resets_at: 1774020000 },
            seven_day: { used_percentage: 15, resets_at: 1774540000 }
        });

        expect(result).not.toBeNull();
        expect(result?.sessionUsage).toBe(42);
        expect(result?.weeklyUsage).toBe(15);
    });

    it('converts epoch seconds to ISO strings for resets_at', () => {
        const result = extractUsageDataFromRateLimits({
            five_hour: { used_percentage: 42, resets_at: 1774020000 },
            seven_day: { used_percentage: 15, resets_at: 1774540000 }
        });

        expect(result?.sessionResetAt).toBe(new Date(1774020000 * 1000).toISOString());
        expect(result?.weeklyResetAt).toBe(new Date(1774540000 * 1000).toISOString());
    });

    it('returns null when rate_limits is null', () => {
        expect(extractUsageDataFromRateLimits(null)).toBeNull();
    });

    it('returns null when rate_limits is undefined', () => {
        expect(extractUsageDataFromRateLimits(undefined)).toBeNull();
    });

    it('extracts reset-only data when percentages are missing', () => {
        const result = extractUsageDataFromRateLimits({ five_hour: { resets_at: 1774020000 } });

        expect(result).not.toBeNull();
        expect(result?.sessionUsage).toBeUndefined();
        expect(result?.sessionResetAt).toBe(epochToIso(1774020000));
        expect(result?.weeklyUsage).toBeUndefined();
    });

    it('extracts partial data when only five_hour is present', () => {
        const result = extractUsageDataFromRateLimits({ five_hour: { used_percentage: 50, resets_at: 1774020000 } });

        expect(result).not.toBeNull();
        expect(result?.sessionUsage).toBe(50);
        expect(result?.weeklyUsage).toBeUndefined();
    });

    it('extracts partial data when only seven_day is present', () => {
        const result = extractUsageDataFromRateLimits({ seven_day: { used_percentage: 10, resets_at: 1774540000 } });

        expect(result).not.toBeNull();
        expect(result?.sessionUsage).toBeUndefined();
        expect(result?.weeklyUsage).toBe(10);
    });

    it('treats used_percentage of 0 as valid data', () => {
        const result = extractUsageDataFromRateLimits({ five_hour: { used_percentage: 0, resets_at: 1774020000 } });

        expect(result).not.toBeNull();
        expect(result?.sessionUsage).toBe(0);
    });

    it('treats null used_percentage as missing while keeping reset data', () => {
        const result = extractUsageDataFromRateLimits({ five_hour: { used_percentage: null, resets_at: 1774020000 } });

        expect(result?.sessionUsage).toBeUndefined();
        expect(result?.sessionResetAt).toBe(epochToIso(1774020000));
    });

    it('extracts per-model weekly buckets when present', () => {
        const result = extractUsageDataFromRateLimits({
            five_hour: { used_percentage: 42, resets_at: 1774020000 },
            seven_day: { used_percentage: 15, resets_at: 1774540000 },
            seven_day_sonnet: { used_percentage: 8, resets_at: 1774540001 },
            seven_day_opus: { used_percentage: 2, resets_at: 1774540002 }
        });

        expect(result?.weeklySonnetUsage).toBe(8);
        expect(result?.weeklyOpusUsage).toBe(2);
        expect(result?.weeklySonnetResetAt).toBe(new Date(1774540001 * 1000).toISOString());
        expect(result?.weeklyOpusResetAt).toBe(new Date(1774540002 * 1000).toISOString());
    });

    it('leaves per-model fields undefined when buckets are absent', () => {
        const result = extractUsageDataFromRateLimits({
            five_hour: { used_percentage: 42, resets_at: 1774020000 },
            seven_day: { used_percentage: 15, resets_at: 1774540000 }
        });

        expect(result?.weeklySonnetUsage).toBeUndefined();
        expect(result?.weeklyOpusUsage).toBeUndefined();
    });

    it('treats null per-model buckets as zero usage', () => {
        const result = extractUsageDataFromRateLimits({
            five_hour: { used_percentage: 42, resets_at: 1774020000 },
            seven_day: { used_percentage: 15, resets_at: 1774540000 },
            seven_day_sonnet: null,
            seven_day_opus: null
        });

        expect(result?.weeklySonnetUsage).toBe(0);
        expect(result?.weeklyOpusUsage).toBe(0);
    });
});
