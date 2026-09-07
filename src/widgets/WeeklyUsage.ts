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
    resolveMonthlyUsageWindow,
    resolveWeeklyUsageWindow,
    shouldPromoteMonthlyUsage
} from '../utils/usage';

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

// When the monthly pool is the tighter cap, the weekly slot renders it with an
// "M"-flavored prefix so the same position always shows the binding number.
function withMonthlyPrefix(item: WidgetItem): WidgetItem {
    const prefix = item.metadata?.prefix;
    if (!prefix) {
        return item;
    }

    return {
        ...item,
        metadata: { ...item.metadata, prefix: prefix.replace(/^W(?=\s|$)/, 'M') }
    };
}

export class WeeklyUsageWidget implements Widget {
    getDefaultColor(): string { return 'brightBlue'; }
    getDescription(): string { return 'Shows weekly API usage percentage'; }
    getDisplayName(): string { return 'Weekly Usage'; }
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
            const previewPercent = 12;
            const renderedPercent = inverted ? 100 - previewPercent : previewPercent;

            if (isUsageProgressMode(displayMode)) {
                const width = getUsageProgressBarWidth(displayMode);
                const progressBar = makeTimerProgressBar(renderedPercent, width, showCursor ? { cursorPercent: 50 } : undefined);
                const progressDisplay = `[${progressBar}] ${formatConfiguredUsagePercent(renderedPercent, format)}`;
                return formatRawOrLabeledValue(item, 'Weekly: ', progressDisplay);
            }

            if (isUsageSliderMode(displayMode)) {
                const slider = makeSliderBar(renderedPercent, undefined, showCursor ? { cursorPercent: 50 } : undefined);
                const sliderDisplay = displayMode === 'slider' ? `${slider} ${formatConfiguredUsagePercent(renderedPercent, format)}` : slider;
                return formatRawOrLabeledValue(item, 'Weekly: ', sliderDisplay);
            }

            return formatRawOrLabeledValue(item, 'Weekly: ', formatConfiguredUsagePercent(renderedPercent, format));
        }

        const data = context.usageData ?? {};
        if (data.weeklyUsage === undefined) {
            if (data.error) {
                return isHidden(item, USAGE_NO_DATA_HIDEABLE_STATE.key)
                    ? null
                    : getUsageErrorMessage(data.error);
            }
            return null;
        }

        // SessionUsage promotes weekly into the primary bar when session is
        // absent. Hide this dedicated weekly widget then so the same percent
        // is not shown twice.
        if (context.hasSessionUsageWidget && data.sessionUsage === undefined) {
            return null;
        }

        // shouldPromoteMonthlyUsage already implies monthlyUsage is defined;
        // keeping the value in a local lets TS narrow it for the ternary.
        const monthlyValue = shouldPromoteMonthlyUsage(data) ? data.monthlyUsage : undefined;
        const monthlyPromoted = monthlyValue !== undefined;
        const label = monthlyPromoted ? 'Monthly: ' : 'Weekly: ';
        const renderItem = monthlyPromoted ? withMonthlyPrefix(item) : item;

        const window = monthlyPromoted ? resolveMonthlyUsageWindow(data) : resolveWeeklyUsageWindow(data);
        if (!monthlyPromoted && window && window.remainingMs <= 0) {
            return data.error ? getUsageErrorMessage(data.error) : null;
        }

        const percent = Math.max(0, Math.min(100, monthlyPromoted ? monthlyValue : data.weeklyUsage));
        const renderedPercent = inverted ? 100 - percent : percent;
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
            return formatRawOrLabeledValue(renderItem, label, withPaceSuffix(progressDisplay, pace, item, colorLevel));
        }

        if (isUsageSliderMode(displayMode)) {
            const slider = makeSliderBar(renderedPercent, undefined, getCursorOptions());
            // slider-only exists to be minimal, so it stays a bare bar.
            if (displayMode !== 'slider') {
                return formatRawOrLabeledValue(renderItem, label, slider);
            }

            const sliderDisplay = `${slider} ${formatConfiguredUsagePercent(renderedPercent, format)}`;
            return formatRawOrLabeledValue(renderItem, label, withPaceSuffix(sliderDisplay, pace, item, colorLevel));
        }

        const percentText = formatConfiguredUsagePercent(renderedPercent, format);
        return formatRawOrLabeledValue(renderItem, label, withPaceSuffix(percentText, pace, item, colorLevel));
    }

    getCustomKeybinds(item?: WidgetItem): CustomKeybind[] {
        return getUsagePercentCustomKeybinds(item);
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
    // Only the pace delta is colored here; the percent keeps the configured
    // color. The renderer gates this on the output actually containing SGR
    // codes, so the plain on-pace output is still colored normally.
    usesInlineColors(): boolean { return true; }
    supportsNumberFormat(): boolean { return true; }
}
