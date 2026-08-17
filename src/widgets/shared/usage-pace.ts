import type { ColorLevelString } from '../../types/ColorLevel';
import type { WidgetItem } from '../../types/Widget';
import { applyColors } from '../../utils/colors';
import {
    SEVEN_DAY_WINDOW_MS,
    type UsageWindowMetrics
} from '../../utils/usage-types';

// The indicator answers one question the percent alone cannot: am I spending
// faster or slower than the window elapses. A positive delta is a deficit (the
// budget runs out early), a negative one is reserve (headroom to spend).
//
// The signal is a difference (usage% - elapsed%) rather than a ratio: over a 7-
// or 30-day window a ratio explodes early on (2% elapsed, 12% used reads as 6x),
// while a difference stays bounded by the window progress itself.
//
// The cutoffs come from CodexBar's pace stages: on track within 2, far
// ahead/behind past 12. It uses them only to word the label, having no pace
// color of its own; a one-line status bar has no room for words, so they drive
// the color here. Calling anything wider than 2 "on pace" would drain the word
// of meaning, so that narrow band is the only colorless one.
const PACE_RED_DELTA = 12;
const PACE_YELLOW_DELTA = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

const YELLOW_COLOR = 'yellow';
const RED_COLOR = 'brightRed';
const GREEN_COLOR = 'green';
const BRIGHT_GREEN_COLOR = 'brightGreen';

export interface UsagePaceIndicator {
    // Left undefined within the on-pace band, where there is nothing to report.
    color?: string;
    text: string;
}

// Milliseconds between two instants that fall on a Mon-Fri day, in local time.
function workdayMsBetween(startMs: number, endMs: number): number {
    if (endMs <= startMs) {
        return 0;
    }

    const firstDay = new Date(startMs);
    firstDay.setHours(0, 0, 0, 0);

    let total = 0;
    for (let dayStart = firstDay.getTime(); dayStart < endMs; dayStart += DAY_MS) {
        const weekday = new Date(dayStart).getDay();
        if (weekday === 0 || weekday === 6) {
            continue;
        }

        const from = Math.max(dayStart, startMs);
        const to = Math.min(dayStart + DAY_MS, endMs);
        if (to > from) {
            total += to - from;
        }
    }

    return total;
}

// A week's budget is not spent evenly across a calendar week — the weekend is
// dead time for most people, so a straight-line baseline reads a normal Friday
// as overspending. Measuring progress in workdays instead keeps the baseline
// aligned with when the budget actually gets used.
//
// Only the weekly window gets this treatment, matching CodexBar: a monthly
// window spans whole weeks, so weekends average out and the straight line is
// already right. Falls back to wall-clock progress for windows that contain no
// workday at all.
function getExpectedUsedPercent(window: UsageWindowMetrics, nowMs: number): number {
    if (window.sessionDurationMs !== SEVEN_DAY_WINDOW_MS) {
        return window.elapsedPercent;
    }

    const startMs = nowMs - window.elapsedMs;
    const endMs = nowMs + window.remainingMs;

    const total = workdayMsBetween(startMs, endMs);
    if (total <= 0) {
        return window.elapsedPercent;
    }

    return (workdayMsBetween(startMs, nowMs) / total) * 100;
}

// Symmetric around the on-pace band, mirroring CodexBar's stages: past 6 is
// ahead/behind, past 12 is far ahead/behind. A deficit gets louder as it grows
// because it calls for action; reserve instead deepens, reading as more of the
// same good news without demanding attention.
function getPaceColor(delta: number): string | undefined {
    if (delta > PACE_RED_DELTA) {
        return RED_COLOR;
    }
    if (delta > PACE_YELLOW_DELTA) {
        return YELLOW_COLOR;
    }
    if (delta < -PACE_RED_DELTA) {
        return GREEN_COLOR;
    }
    if (delta < -PACE_YELLOW_DELTA) {
        return BRIGHT_GREEN_COLOR;
    }
    return undefined;
}

// Long windows (weekly, monthly) leave no intuition for whether a given percent
// is ahead or behind, so this carries that judgement alongside the percent.
// Returns null only when there is no window to compare against, or too early in
// one for the delta to mean anything.
export function getUsagePaceIndicator(
    percent: number,
    window?: UsageWindowMetrics | null,
    nowMs = Date.now()
): UsagePaceIndicator | null {
    if (!window) {
        return null;
    }

    // Usage reported against a window that has not started yet cannot be paced
    // against it; the reset time is stale or wrong.
    if (window.elapsedMs <= 0 && percent > 0) {
        return null;
    }

    const delta = Math.round(percent - getExpectedUsedPercent(window, nowMs));
    return {
        color: getPaceColor(delta),
        text: delta >= 0 ? `+${delta}%` : `${delta}%`
    };
}

// Appends the pace delta to an already-rendered body, coloring each part
// separately. Emitting any SGR makes the renderer skip the configured
// foreground color for the whole widget, so the body carries it here instead.
export function withPaceSuffix(
    body: string,
    pace: UsagePaceIndicator | null,
    item: WidgetItem,
    colorLevel: ColorLevelString
): string {
    if (!pace) {
        return body;
    }

    const head = item.color ? applyColors(body, item.color, undefined, false, colorLevel) : body;
    const tail = pace.color ? applyColors(pace.text, pace.color, undefined, false, colorLevel) : pace.text;
    return `${head} ${tail}`;
}
