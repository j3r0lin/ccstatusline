import { getColorLevelString } from '../types/ColorLevel';
import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    CustomKeybind,
    HideableState,
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import {
    formatPercent,
    resolveNumberFormat
} from '../utils/number-format';
import {
    getUsageErrorMessage,
    resolveUsageWindowWithFallback,
    resolveWeeklyUsageWindow
} from '../utils/usage';
import type { UsageData } from '../utils/usage-types';

import { isHidden } from './shared/hideable';
import { makeTimerProgressBar } from './shared/progress-bar';
import { formatRawOrLabeledValue } from './shared/raw-or-labeled';
import {
    USAGE_NO_DATA_HIDEABLE_STATE,
    cycleUsageDisplayMode,
    getUsageDisplayMode,
    getUsageDisplayModifierText,
    getUsagePercentCustomKeybinds,
    getUsageProgressBarWidth,
    isUsageCursorEnabled,
    isUsageInverted,
    isUsageProgressMode,
    isUsageSliderMode,
    makeSliderBar,
    toggleUsageCursor,
    toggleUsageInverted
} from './shared/usage-display';
import {
    getUsagePaceIndicator,
    withPaceSuffix
} from './shared/usage-pace';

function formatConfiguredUsagePercent(value: number, format: ReturnType<typeof resolveNumberFormat>): string {
    const rendered = formatPercent(value, format);
    return format.style === undefined && format.decimals === undefined
        ? rendered.replace(/\.0%$/, '%')
        : rendered;
}

const SESSION_LABEL = 'Session: ';
const PROMOTED_WEEKLY_LABEL = 'Weekly: ';

export interface SessionUsageDisplaySource {
    percent: number;
    promoted: boolean;
}

/**
 * Prefer the 5h session window; when a provider only exposes weekly/credits,
 * promote weekly into the session slot so the primary bar stays filled.
 */
export function resolveSessionUsageDisplaySource(data: UsageData): SessionUsageDisplaySource | null {
    if (data.sessionUsage !== undefined) {
        return {
            percent: data.sessionUsage,
            promoted: false
        };
    }

    if (data.weeklyUsage !== undefined) {
        return {
            percent: data.weeklyUsage,
            promoted: true
        };
    }

    return null;
}

function getSessionUsageLabel(promoted: boolean): string {
    return promoted ? PROMOTED_WEEKLY_LABEL : SESSION_LABEL;
}

export class SessionUsageWidget implements Widget {
    getDefaultColor(): string { return 'brightBlue'; }
    getDescription(): string {
        return 'Shows session API usage percentage. When session usage is unavailable, falls back to weekly usage so the primary bar stays filled.';
    }

    getDisplayName(): string { return 'Session Usage'; }
    getCategory(): string { return 'Usage'; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return {
            displayText: this.getDisplayName(),
            modifierText: getUsageDisplayModifierText(item, { showUsageDirection: true })
        };
    }

    getHideableStates(): HideableState[] {
        return [USAGE_NO_DATA_HIDEABLE_STATE];
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        if (action === 'toggle-progress') {
            return cycleUsageDisplayMode(item, [], true, true);
        }

        if (action === 'toggle-invert') {
            return toggleUsageInverted(item);
        }

        if (action === 'toggle-cursor') {
            return toggleUsageCursor(item);
        }

        return null;
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const displayMode = getUsageDisplayMode(item);
        const inverted = isUsageInverted(item);
        const showCursor = isUsageCursorEnabled(item);
        const format = resolveNumberFormat('percent', item, settings);

        if (context.isPreview) {
            const previewPercent = 20;
            const renderedPercent = inverted ? 100 - previewPercent : previewPercent;

            if (isUsageProgressMode(displayMode)) {
                const width = getUsageProgressBarWidth(displayMode);
                const progressBar = makeTimerProgressBar(renderedPercent, width, showCursor ? { cursorPercent: 50 } : undefined);
                const progressDisplay = `[${progressBar}] ${formatConfiguredUsagePercent(renderedPercent, format)}`;
                return formatRawOrLabeledValue(item, SESSION_LABEL, progressDisplay);
            }

            if (isUsageSliderMode(displayMode)) {
                const slider = makeSliderBar(renderedPercent, undefined, showCursor ? { cursorPercent: 50 } : undefined);
                const sliderDisplay = displayMode === 'slider' ? `${slider} ${formatConfiguredUsagePercent(renderedPercent, format)}` : slider;
                return formatRawOrLabeledValue(item, SESSION_LABEL, sliderDisplay);
            }

            return formatRawOrLabeledValue(item, SESSION_LABEL, formatConfiguredUsagePercent(renderedPercent, format));
        }

        const data = context.usageData ?? {};
        const source = resolveSessionUsageDisplaySource(data);
        if (!source) {
            if (data.error) {
                return isHidden(item, USAGE_NO_DATA_HIDEABLE_STATE.key)
                    ? null
                    : getUsageErrorMessage(data.error);
            }
            return null;
        }

        // Follows the promoted source, so a weekly percent is paced against the
        // weekly window rather than the five-hour one.
        const window = source.promoted
            ? resolveWeeklyUsageWindow(data)
            : resolveUsageWindowWithFallback(data, context.blockMetrics);
        if (source.promoted && (!window || window.remainingMs <= 0)) {
            return data.error ? getUsageErrorMessage(data.error) : null;
        }

        const percent = Math.max(0, Math.min(100, source.percent));
        const renderedPercent = inverted ? 100 - percent : percent;
        const label = getSessionUsageLabel(source.promoted);
        const getCursorOptions = (): { cursorPercent: number } | undefined => {
            if (!showCursor) {
                return undefined;
            }

            return window ? { cursorPercent: window.elapsedPercent } : undefined;
        };

        const colorLevel = getColorLevelString(settings.colorLevel);
        const pace = getUsagePaceIndicator(percent, window);

        if (isUsageProgressMode(displayMode)) {
            const width = getUsageProgressBarWidth(displayMode);

            const progressBar = makeTimerProgressBar(renderedPercent, width, getCursorOptions());
            const progressDisplay = `[${progressBar}] ${formatConfiguredUsagePercent(renderedPercent, format)}`;
            return formatRawOrLabeledValue(item, label, withPaceSuffix(progressDisplay, pace, item, colorLevel));
        }

        if (isUsageSliderMode(displayMode)) {
            const slider = makeSliderBar(renderedPercent, undefined, getCursorOptions());
            // slider-only exists to be minimal, so it stays a bare bar.
            if (displayMode !== 'slider') {
                return formatRawOrLabeledValue(item, label, slider);
            }

            const sliderDisplay = `${slider} ${formatConfiguredUsagePercent(renderedPercent, format)}`;
            return formatRawOrLabeledValue(item, label, withPaceSuffix(sliderDisplay, pace, item, colorLevel));
        }

        const percentText = formatConfiguredUsagePercent(renderedPercent, format);
        return formatRawOrLabeledValue(item, label, withPaceSuffix(percentText, pace, item, colorLevel));
    }

    renderCompact(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const displayMode = getUsageDisplayMode(item);
        const format = resolveNumberFormat('percent', item, settings);
        if (!isUsageSliderMode(displayMode))
            return null;

        if (context.isPreview) {
            const previewPercent = 20;
            const renderedPercent = isUsageInverted(item) ? 100 - previewPercent : previewPercent;
            return formatRawOrLabeledValue(item, SESSION_LABEL, formatConfiguredUsagePercent(renderedPercent, format));
        }

        const data = context.usageData ?? {};
        const source = resolveSessionUsageDisplaySource(data);
        if (!source)
            return null;
        if (source.promoted) {
            const window = resolveWeeklyUsageWindow(data);
            if (!window || window.remainingMs <= 0) {
                return null;
            }
        }

        const percent = Math.max(0, Math.min(100, source.percent));
        const renderedPercent = isUsageInverted(item) ? 100 - percent : percent;
        return formatRawOrLabeledValue(item, getSessionUsageLabel(source.promoted), formatConfiguredUsagePercent(renderedPercent, format));
    }

    getCustomKeybinds(item?: WidgetItem): CustomKeybind[] {
        return getUsagePercentCustomKeybinds(item);
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
    // The pace delta carries its own color, so the renderer hands color
    // handling to this widget whenever a delta is present.
    usesInlineColors(): boolean { return true; }
    supportsNumberFormat(): boolean { return true; }
}
