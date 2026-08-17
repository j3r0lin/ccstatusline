import { getColorLevelString } from '../types/ColorLevel';
import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    CustomKeybind,
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import { applyColors } from '../utils/colors';
import {
    getUsageErrorMessage,
    resolveMonthlyUsageWindow,
    shouldPromoteMonthlyUsage
} from '../utils/usage';

import { makeTimerProgressBar } from './shared/progress-bar';
import { formatRawOrLabeledValue } from './shared/raw-or-labeled';
import {
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
import { getUsagePaceIndicator } from './shared/usage-pace';

export class MonthlyUsageWidget implements Widget {
    getDefaultColor(): string { return 'brightMagenta'; }
    getDescription(): string { return 'Shows monthly membership pool usage percentage (Kimi)'; }
    getDisplayName(): string { return 'Monthly Usage'; }
    getCategory(): string { return 'Usage'; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return {
            displayText: this.getDisplayName(),
            modifierText: getUsageDisplayModifierText(item, { showUsageDirection: true })
        };
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

        if (context.isPreview) {
            const previewPercent = 12;
            const renderedPercent = inverted ? 100 - previewPercent : previewPercent;

            if (isUsageProgressMode(displayMode)) {
                const width = getUsageProgressBarWidth(displayMode);
                const progressBar = makeTimerProgressBar(renderedPercent, width, showCursor ? { cursorPercent: 50 } : undefined);
                const progressDisplay = `[${progressBar}] ${renderedPercent.toFixed(1)}%`;
                return formatRawOrLabeledValue(item, 'Monthly: ', progressDisplay);
            }

            if (isUsageSliderMode(displayMode)) {
                const slider = makeSliderBar(renderedPercent, undefined, showCursor ? { cursorPercent: 50 } : undefined);
                const sliderDisplay = displayMode === 'slider' ? `${slider} ${renderedPercent.toFixed(1)}%` : slider;
                return formatRawOrLabeledValue(item, 'Monthly: ', sliderDisplay);
            }

            return formatRawOrLabeledValue(item, 'Monthly: ', `${renderedPercent.toFixed(1)}%`);
        }

        const data = context.usageData ?? {};
        if (data.monthlyUsage === undefined) {
            if (data.error)
                return getUsageErrorMessage(data.error);
            return null;
        }

        // When the monthly pool is the tighter cap and a weekly-usage widget is
        // configured, the weekly slot renders it (as "M …") instead. Hide this
        // dedicated widget then so the same percent is not shown twice.
        if (context.hasWeeklyUsageWidget && data.weeklyUsage !== undefined && shouldPromoteMonthlyUsage(data)) {
            return null;
        }

        const percent = Math.max(0, Math.min(100, data.monthlyUsage));
        const renderedPercent = inverted ? 100 - percent : percent;
        const window = resolveMonthlyUsageWindow(data);
        const getCursorOptions = (): { cursorPercent: number } | undefined => {
            if (!showCursor) {
                return undefined;
            }

            return window ? { cursorPercent: window.elapsedPercent } : undefined;
        };

        if (isUsageProgressMode(displayMode)) {
            const width = getUsageProgressBarWidth(displayMode);

            const progressBar = makeTimerProgressBar(renderedPercent, width, getCursorOptions());
            const progressDisplay = `[${progressBar}] ${renderedPercent.toFixed(1)}%`;
            return formatRawOrLabeledValue(item, 'Monthly: ', progressDisplay);
        }

        if (isUsageSliderMode(displayMode)) {
            const slider = makeSliderBar(renderedPercent, undefined, getCursorOptions());
            const sliderDisplay = displayMode === 'slider' ? `${slider} ${renderedPercent.toFixed(1)}%` : slider;
            return formatRawOrLabeledValue(item, 'Monthly: ', sliderDisplay);
        }

        // Bar modes already show pace as the cursor, so the delta only appears
        // in text mode, where nothing else conveys it.
        const percentText = `${renderedPercent.toFixed(1)}%`;
        const pace = getUsagePaceIndicator(percent, window);
        if (!pace) {
            return formatRawOrLabeledValue(item, 'Monthly: ', percentText);
        }

        // Emitting any SGR here makes the renderer skip the configured
        // foreground color for the whole widget, so apply it to the percent
        // ourselves to keep it working alongside the pace color.
        const colorLevel = getColorLevelString(settings.colorLevel);
        const percentPart = item.color
            ? applyColors(percentText, item.color, undefined, false, colorLevel)
            : percentText;
        const paceText = pace.color
            ? applyColors(pace.text, pace.color, undefined, false, colorLevel)
            : pace.text;
        return formatRawOrLabeledValue(item, 'Monthly: ', `${percentPart} ${paceText}`);
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
}
