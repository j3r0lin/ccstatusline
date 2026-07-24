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
    resolveUsageWindowWithFallback,
    resolveWeeklyUsageWindow
} from '../utils/usage';
import type { UsageData } from '../utils/usage-types';

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
            const previewPercent = 20;
            const renderedPercent = inverted ? 100 - previewPercent : previewPercent;

            if (isUsageProgressMode(displayMode)) {
                const width = getUsageProgressBarWidth(displayMode);
                const progressBar = makeTimerProgressBar(renderedPercent, width, showCursor ? { cursorPercent: 50 } : undefined);
                const progressDisplay = `[${progressBar}] ${renderedPercent.toFixed(1)}%`;
                return formatRawOrLabeledValue(item, SESSION_LABEL, progressDisplay);
            }

            if (isUsageSliderMode(displayMode)) {
                const slider = makeSliderBar(renderedPercent, undefined, showCursor ? { cursorPercent: 50 } : undefined);
                const sliderDisplay = displayMode === 'slider' ? `${slider} ${renderedPercent.toFixed(1)}%` : slider;
                return formatRawOrLabeledValue(item, SESSION_LABEL, sliderDisplay);
            }

            return formatRawOrLabeledValue(item, SESSION_LABEL, `${renderedPercent.toFixed(1)}%`);
        }

        const data = context.usageData ?? {};
        const source = resolveSessionUsageDisplaySource(data);
        if (!source) {
            if (data.error)
                return getUsageErrorMessage(data.error);
            return null;
        }

        const percent = Math.max(0, Math.min(100, source.percent));
        const renderedPercent = inverted ? 100 - percent : percent;
        const label = getSessionUsageLabel(source.promoted);
        const getCursorOptions = (): { cursorPercent: number } | undefined => {
            if (!showCursor) {
                return undefined;
            }

            const window = source.promoted
                ? resolveWeeklyUsageWindow(data)
                : resolveUsageWindowWithFallback(data, context.blockMetrics);
            return window ? { cursorPercent: window.elapsedPercent } : undefined;
        };

        if (isUsageProgressMode(displayMode)) {
            const width = getUsageProgressBarWidth(displayMode);

            const progressBar = makeTimerProgressBar(renderedPercent, width, getCursorOptions());
            const progressDisplay = `[${progressBar}] ${renderedPercent.toFixed(1)}%`;
            return formatRawOrLabeledValue(item, label, progressDisplay);
        }

        if (isUsageSliderMode(displayMode)) {
            const slider = makeSliderBar(renderedPercent, undefined, getCursorOptions());
            const sliderDisplay = displayMode === 'slider' ? `${slider} ${renderedPercent.toFixed(1)}%` : slider;
            return formatRawOrLabeledValue(item, label, sliderDisplay);
        }

        return formatRawOrLabeledValue(item, label, `${renderedPercent.toFixed(1)}%`);
    }

    renderCompact(item: WidgetItem, context: RenderContext, _settings: Settings): string | null {
        const displayMode = getUsageDisplayMode(item);
        if (!isUsageSliderMode(displayMode))
            return null;

        if (context.isPreview) {
            const previewPercent = 20;
            const renderedPercent = isUsageInverted(item) ? 100 - previewPercent : previewPercent;
            return formatRawOrLabeledValue(item, SESSION_LABEL, `${renderedPercent.toFixed(1)}%`);
        }

        const data = context.usageData ?? {};
        const source = resolveSessionUsageDisplaySource(data);
        if (!source)
            return null;

        const percent = Math.max(0, Math.min(100, source.percent));
        const renderedPercent = isUsageInverted(item) ? 100 - percent : percent;
        return formatRawOrLabeledValue(item, getSessionUsageLabel(source.promoted), `${renderedPercent.toFixed(1)}%`);
    }

    getCustomKeybinds(item?: WidgetItem): CustomKeybind[] {
        return getUsagePercentCustomKeybinds(item);
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
