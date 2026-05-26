import { getColorLevelString } from '../types/ColorLevel';
import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import { applyColors } from '../utils/colors';
import {
    FIVE_HOUR_BLOCK_MS,
    getUsageErrorMessage
} from '../utils/usage';

import { formatRawOrLabeledValue } from './shared/raw-or-labeled';

const MIN_ELAPSED_MS = 10 * 60 * 1000; // 10 minutes
const MIN_USAGE_PERCENT = 5;

function getProjectionColor(projected: number): string {
    if (projected >= 95)
        return 'brightRed';
    if (projected >= 80)
        return 'yellow';
    return 'brightGreen';
}

export class UsageProjectionWidget implements Widget {
    getDefaultColor(): string { return 'brightGreen'; }
    getDescription(): string { return 'Projects 5hr window usage at reset based on current consumption rate'; }
    getDisplayName(): string { return 'Usage Projection'; }
    getCategory(): string { return 'Usage'; }

    getEditorDisplay(_item: WidgetItem): WidgetEditorDisplay {
        return { displayText: this.getDisplayName() };
    }

    handleEditorAction(_action: string, _item: WidgetItem): WidgetItem | null {
        return null;
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const colorLevel = getColorLevelString(settings.colorLevel);

        if (context.isPreview) {
            const previewText = applyColors('→ 72%', 'brightGreen', undefined, false, colorLevel);
            return formatRawOrLabeledValue(item, 'Proj: ', previewText);
        }

        const usageData = context.usageData ?? {};

        if (usageData.error) {
            return getUsageErrorMessage(usageData.error);
        }

        const { sessionUsage, sessionResetAt } = usageData;
        if (sessionUsage === undefined || !sessionResetAt) {
            return null;
        }

        const remainingMs = new Date(sessionResetAt).getTime() - Date.now();
        if (remainingMs <= 0) {
            return null;
        }

        const elapsedMs = FIVE_HOUR_BLOCK_MS - remainingMs;
        if (elapsedMs <= 0) {
            return null;
        }

        // Not enough data yet — wait for 10 min elapsed or 5% usage
        if (elapsedMs < MIN_ELAPSED_MS && sessionUsage < MIN_USAGE_PERCENT) {
            return null;
        }

        const projected = sessionUsage * (FIVE_HOUR_BLOCK_MS / elapsedMs);
        const colorName = getProjectionColor(projected);
        const displayPercent = projected > 200 ? '>200' : projected.toFixed(0);

        const text = applyColors(`→ ${displayPercent}%`, colorName, undefined, false, colorLevel);
        return formatRawOrLabeledValue(item, 'Proj: ', text);
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(_item: WidgetItem): boolean { return false; }
}
