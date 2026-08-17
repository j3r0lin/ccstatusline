import type { UsageWindowMetrics } from '../../utils/usage-types';

// The indicator answers one question the percent alone cannot: am I spending
// faster or slower than the window elapses. A positive delta is a deficit (the
// budget runs out early), a negative one is reserve (headroom to spend).
//
// The signal is a difference (usage% - elapsed%) rather than a ratio: over a 7-
// or 30-day window a ratio explodes early on (2% elapsed, 12% used reads as 6x),
// while a difference stays bounded by the window progress itself.
const PACE_RED_DELTA = 15;
const PACE_YELLOW_DELTA = 5;

// Below this much elapsed, a single morning of work is enough to push the delta
// past the yellow threshold. Staying silent here keeps Monday mornings and the
// first day of a billing cycle from crying wolf.
const PACE_MIN_ELAPSED_PERCENT = 10;

const YELLOW_COLOR = 'yellow';
const RED_COLOR = 'brightRed';

export interface UsagePaceIndicator {
    // Left undefined while on pace or in reserve, so only a deficit draws the
    // eye and the percent keeps the user's configured color.
    color?: string;
    text: string;
}

function getDeficitColor(delta: number): string | undefined {
    if (delta >= PACE_RED_DELTA) {
        return RED_COLOR;
    }
    if (delta >= PACE_YELLOW_DELTA) {
        return YELLOW_COLOR;
    }
    return undefined;
}

// Long windows (weekly, monthly) leave no intuition for whether a given percent
// is ahead or behind, so this carries that judgement alongside the percent.
// Returns null only when there is no window to compare against, or too early in
// one for the delta to mean anything.
export function getUsagePaceIndicator(percent: number, window?: UsageWindowMetrics | null): UsagePaceIndicator | null {
    if (!window || window.elapsedPercent < PACE_MIN_ELAPSED_PERCENT) {
        return null;
    }

    const delta = Math.round(percent - window.elapsedPercent);
    return {
        color: getDeficitColor(delta),
        text: delta >= 0 ? `+${delta}` : `${delta}`
    };
}
