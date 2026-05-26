import { getColorLevelString } from '../types/ColorLevel';
import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import { applyColors } from '../utils/colors';

import { formatRawOrLabeledValue } from './shared/raw-or-labeled';

const WARN_MS = 5 * 60 * 1000;
const DANGER_MS = 15 * 60 * 1000;
const STALE_MS = 60 * 60 * 1000;

function formatElapsed(elapsedMs: number): string {
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);

    if (minutes === 0) {
        return `${totalSeconds}s`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours === 0) {
        return `${minutes}m`;
    }

    const remainMinutes = minutes % 60;
    if (remainMinutes === 0) {
        return `${hours}h`;
    }

    return `${hours}h${remainMinutes}m`;
}

function getIdleColor(elapsedMs: number): string {
    if (elapsedMs >= STALE_MS)
        return 'hex:F92672';
    if (elapsedMs >= DANGER_MS)
        return 'ansi256:202';
    if (elapsedMs >= WARN_MS)
        return 'yellow';
    return 'brightGreen';
}

export class IdleWidget implements Widget {
    getDefaultColor(): string { return 'brightGreen'; }
    getDescription(): string { return 'Shows time elapsed since last API completion in this session'; }
    getDisplayName(): string { return 'Idle'; }
    getCategory(): string { return 'Session'; }

    getEditorDisplay(_item: WidgetItem): WidgetEditorDisplay {
        return { displayText: this.getDisplayName() };
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const colorLevel = getColorLevelString(settings.colorLevel);

        if (context.isPreview) {
            const text = applyColors('󰔛 2m', 'brightGreen', undefined, false, colorLevel);
            return formatRawOrLabeledValue(item, 'Idle: ', text);
        }

        const lastMs = context.lastCompletionMs;
        if (lastMs === null || lastMs === undefined) {
            return null;
        }

        const elapsedMs = Date.now() - lastMs;
        const color = getIdleColor(elapsedMs);
        const text = applyColors(`󰔛 ${formatElapsed(elapsedMs)}`, color, undefined, false, colorLevel);
        return formatRawOrLabeledValue(item, 'Idle: ', text);
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(_item: WidgetItem): boolean { return false; }
}
