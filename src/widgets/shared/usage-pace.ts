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

// A triangle rather than a signed percent: it marks the number as a comparison
// against the window's own progress, which a second "%" next to the usage
// percent would read as just another absolute figure.
const AHEAD_MARK = '▴';
const BEHIND_MARK = '▾';

const YELLOW_COLOR = 'yellow';
const RED_COLOR = 'brightRed';
const GREEN_COLOR = 'green';
const BRIGHT_GREEN_COLOR = 'brightGreen';

export interface UsagePaceIndicator {
    // Left undefined within the on-pace band, where there is nothing to report.
    color?: string;
    text: string;
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

const HOUR_MS = 60 * 60 * 1000;

// Hours between two instants, a Saturday or Sunday hour (local time) counting
// as weekendDays/2 of one.
function weightedHours(startMs: number, endMs: number, weekendDays: number): number {
    let total = 0;
    for (let t = startMs; t < endMs;) {
        const midnight = new Date(t);
        midnight.setHours(24, 0, 0, 0);
        const to = Math.min(midnight.getTime(), endMs);
        const weekday = new Date(t).getDay();
        total += ((to - t) / HOUR_MS) * (weekday === 0 || weekday === 6 ? weekendDays / 2 : 1);
        t = to;
    }
    return total;
}

// Weekends get used, but less and not on a fixed day, so the weekly line counts
// them at a reduced weight instead of skipping a given day. Any 168 hours hold
// 48 of weekend, so a week always weighs 120 + 24 * weekendDays hours. The
// 5-hour and monthly windows keep the wall clock.
function getExpectedPercent(window: UsageWindowMetrics, weekendDays: number, nowMs: number): number {
    if (window.sessionDurationMs !== SEVEN_DAY_WINDOW_MS) {
        return window.elapsedPercent;
    }
    const elapsed = weightedHours(nowMs - window.elapsedMs, nowMs, weekendDays);
    return (elapsed / (120 + 24 * weekendDays)) * 100;
}

// Long windows (weekly, monthly) leave no intuition for whether a given percent
// is ahead or behind, so this carries that judgement alongside the percent.
// Returns null only when there is no window to compare against, or too early in
// one for the delta to mean anything.
export function getUsagePaceIndicator(
    percent: number,
    window?: UsageWindowMetrics | null,
    weekendDays = 2,
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

    const delta = Math.round(percent - getExpectedPercent(window, weekendDays, nowMs));
    return {
        color: getPaceColor(delta),
        text: `${delta >= 0 ? AHEAD_MARK : BEHIND_MARK}${Math.abs(delta)}`
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
