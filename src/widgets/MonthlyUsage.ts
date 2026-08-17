import { getColorLevelString } from '../types/ColorLevel';
import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    CustomKeybind,
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import {
    getUsageErrorMessage,
    resolveMonthlyUsageWindow,
    shouldPromoteMonthlyUsage
} from '../utils/usage';

import { makeTimerProgressBar } from './shared/progress-bar';
import { formatRawOrLabeledValue } from './shared/raw-or-labeled';
import {
    cycleUsageDisplayMode,
    formatUsagePercent,
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
                const progressDisplay = `[${progressBar}] ${formatUsagePercent(renderedPercent)}`;
                return formatRawOrLabeledValue(item, 'Monthly: ', progressDisplay);
            }

            if (isUsageSliderMode(displayMode)) {
                const slider = makeSliderBar(renderedPercent, undefined, showCursor ? { cursorPercent: 50 } : undefined);
                const sliderDisplay = displayMode === 'slider' ? `${slider} ${formatUsagePercent(renderedPercent)}` : slider;
                return formatRawOrLabeledValue(item, 'Monthly: ', sliderDisplay);
            }

            return formatRawOrLabeledValue(item, 'Monthly: ', formatUsagePercent(renderedPercent));
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

        const colorLevel = getColorLevelString(settings.colorLevel);
        const pace = getUsagePaceIndicator(percent, window);

        if (isUsageProgressMode(displayMode)) {
            const width = getUsageProgressBarWidth(displayMode);

            const progressBar = makeTimerProgressBar(renderedPercent, width, getCursorOptions());
            const progressDisplay = `[${progressBar}] ${formatUsagePercent(renderedPercent)}`;
            return formatRawOrLabeledValue(item, 'Monthly: ', withPaceSuffix(progressDisplay, pace, item, colorLevel));
        }

        if (isUsageSliderMode(displayMode)) {
            const slider = makeSliderBar(renderedPercent, undefined, getCursorOptions());
            // slider-only exists to be minimal, so it stays a bare bar.
            if (displayMode !== 'slider') {
                return formatRawOrLabeledValue(item, 'Monthly: ', slider);
            }

            const sliderDisplay = `${slider} ${formatUsagePercent(renderedPercent)}`;
            return formatRawOrLabeledValue(item, 'Monthly: ', withPaceSuffix(sliderDisplay, pace, item, colorLevel));
        }

        const percentText = formatUsagePercent(renderedPercent);
        return formatRawOrLabeledValue(item, 'Monthly: ', withPaceSuffix(percentText, pace, item, colorLevel));
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
