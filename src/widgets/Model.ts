import { getColorLevelString } from '../types/ColorLevel';
import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    CustomKeybind,
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import { getColorAnsiCode } from '../utils/colors';
import {
    colorizeModelName,
    resolveThinkingEffort
} from '../utils/thinking-effort';

const RESET = '\x1b[0m';

function isEffortColor(item: WidgetItem): boolean {
    return item.metadata?.effortColor === 'true';
}

function formatModelDisplayName(name: string): string {
    if (/kimi/i.test(name)) {
        return 'Kimi';
    }

    return name.replace(/^Claude\s+/i, '').replace(/\s*\(.*\)$/, '');
}

export class ModelWidget implements Widget {
    getDefaultColor(): string { return 'cyan'; }
    getDescription(): string { return 'Displays the Claude model name (e.g., Claude 3.5 Sonnet).\nOptionally colors the name by thinking effort: low=gold, medium=green, high=lavender, xhigh=purple, max=rainbow.'; }
    getDisplayName(): string { return 'Model'; }
    getCategory(): string { return 'Core'; }
    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return {
            displayText: this.getDisplayName(),
            modifierText: isEffortColor(item) ? '(effort color)' : undefined
        };
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        if (action !== 'toggle-effort-color') {
            return null;
        }

        return {
            ...item,
            metadata: {
                ...(item.metadata ?? {}),
                effortColor: isEffortColor(item) ? 'false' : 'true'
            }
        };
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const effortColor = isEffortColor(item);
        const colorLevel = getColorLevelString(settings.colorLevel);

        if (context.isPreview) {
            const sample = 'Claude';
            const colored = effortColor
                ? colorizeModelName(sample, { value: 'high', known: true }, colorLevel)
                : null;
            return this.compose(item, colored ?? sample, colored !== null, colorLevel);
        }

        const model = context.data?.model;
        const modelDisplayName = typeof model === 'string'
            ? model
            : (model?.display_name ?? model?.id);

        if (!modelDisplayName) {
            return null;
        }

        const shortName = formatModelDisplayName(modelDisplayName);
        const colored = effortColor
            ? colorizeModelName(shortName, resolveThinkingEffort(context), colorLevel)
            : null;
        return this.compose(item, colored ?? shortName, colored !== null, colorLevel);
    }

    // Builds the final output. When the name carries inline effort colors, the
    // "Model: " label keeps the widget's base color so only the value is recolored.
    private compose(item: WidgetItem, value: string, valueIsColored: boolean, colorLevel: ReturnType<typeof getColorLevelString>): string {
        if (item.rawValue) {
            return value;
        }
        if (!valueIsColored) {
            return `Model: ${value}`;
        }
        const labelCode = getColorAnsiCode(item.color ?? this.getDefaultColor(), colorLevel, false);
        return `${labelCode}Model: ${RESET}${value}`;
    }

    getCustomKeybinds(): CustomKeybind[] {
        return [
            { key: 'e', label: '(e)ffort color toggle', action: 'toggle-effort-color' }
        ];
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
    usesInlineColors(item: WidgetItem): boolean { return isEffortColor(item); }
}
