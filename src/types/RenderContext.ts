import type {
    BlockMetrics,
    SkillsMetrics
} from '../types';

import type { SpeedMetrics } from './SpeedMetrics';
import type { StatusJSON } from './StatusJSON';
import type { TokenMetrics } from './TokenMetrics';

export interface RenderUsageData {
    sessionUsage?: number;
    sessionResetAt?: string;
    weeklyUsage?: number;
    weeklyResetAt?: string;
    weeklySonnetUsage?: number;
    weeklySonnetResetAt?: string;
    weeklyOpusUsage?: number;
    weeklyOpusResetAt?: string;
    monthlyUsage?: number;
    monthlyResetAt?: string;
    fableUsage?: number;
    fableResetAt?: string;
    extraUsageEnabled?: boolean;
    extraUsageLimit?: number;
    extraUsageUsed?: number;
    extraUsageUtilization?: number;
    extraUsageCurrency?: string;
    error?: 'no-credentials' | 'timeout' | 'rate-limited' | 'api-error' | 'parse-error';
}

export interface CompactionData {
    count: number;
    byTrigger: { auto: number; manual: number; unknown: number };
    tokensReclaimed: number;
}

export interface RenderContext {
    data?: StatusJSON;
    tokenMetrics?: TokenMetrics | null;
    speedMetrics?: SpeedMetrics | null;
    windowedSpeedMetrics?: Record<string, SpeedMetrics> | null;
    usageData?: RenderUsageData | null;
    sessionDuration?: string | null;
    blockMetrics?: BlockMetrics | null;
    skillsMetrics?: SkillsMetrics | null;
    compactionData?: CompactionData | null;
    lastCompletionMs?: number | null;
    /**
     * True when the transcript's newest main-chain row is still a user turn
     * (prompt or tool result) awaiting an assistant reply — model is working.
     */
    turnInFlight?: boolean;
    lastPrompt?: string | null;
    /** Effort from the transcript's latest /model|/effort marker; null = checked, none found */
    transcriptThinkingEffort?: {
        value: string;
        known: boolean;
    } | null;
    terminalWidth?: number | null;
    isPreview?: boolean;
    minimalist?: boolean;
    gitCacheTtlSeconds?: number;
    /**
     * True when a session-usage widget is configured on any line.
     * WeeklyUsage uses this to hide itself when session has promoted weekly
     * into the primary slot (providers with no session window).
     */
    hasSessionUsageWidget?: boolean;
    /**
     * True when a weekly-usage widget is configured on any line.
     * MonthlyUsage uses this to hide itself when the weekly slot has promoted
     * the monthly pool (the tighter cap) into its place.
     */
    hasWeeklyUsageWidget?: boolean;
    gitReviewNeedsChecks?: boolean;
    lineIndex?: number;  // Index of the current line being rendered (for theme cycling)
    globalSeparatorIndex?: number;  // Global separator index that continues across lines

    // For git widget thresholds
    gitData?: {
        changedFiles?: number;
        insertions?: number;
        deletions?: number;
    };
    globalPowerlineThemeIndex?: number;  // Global powerline theme index that continues across lines
    globalPowerlineStartCapIndex?: number;  // Global start cap index across powerline flex segments and lines
}
