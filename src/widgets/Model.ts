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

interface ModelInfo {
    id?: string;
    display_name?: string;
}

function formatGrokModelName(id: string | undefined, name: string | undefined): string | null {
    const haystack = `${id ?? ''} ${name ?? ''}`;
    if (!/grok/i.test(haystack)) {
        return null;
    }

    // Keep an already human-readable display_name (e.g. "Grok 4.5").
    if (name && /grok/i.test(name) && (/\s/.test(name) || /^[A-Z]/.test(name))) {
        return name.replace(/\s*\(.*\)$/, '').trim();
    }

    const slug = (id ?? name ?? '')
        .replace(/^xai\//i, '')
        .replace(/\[1m\]$/i, '');

    const versionMatch = /^grok[-_]?(\d+(?:\.\d+)?)$/i.exec(slug);
    if (versionMatch) {
        return `Grok ${versionMatch[1]}`;
    }

    if (/^grok[-_]?code[-_]?fast/i.test(slug)) {
        return 'Grok Code Fast';
    }

    if (/^grok[-_]?code/i.test(slug)) {
        return 'Grok Code';
    }

    return slug
        .split(/[-_]+/)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ');
}

function formatModelDisplayName(model: string | ModelInfo): string {
    const id = typeof model === 'string' ? undefined : model.id;
    const name = typeof model === 'string' ? model : (model.display_name ?? model.id);

    if (/kimi-for-coding-highspeed/i.test(id ?? '') || /kimi-for-coding-highspeed/i.test(name ?? '')) {
        return 'Kimi Fast';
    }

    if (/^k3(?:\[1m\])?$/i.test(id ?? '')) {
        return 'K3';
    }

    if (/kimi/i.test(name ?? '')) {
        return 'Kimi';
    }

    const grokName = formatGrokModelName(id, name);
    if (grokName) {
        return grokName;
    }

    return (name ?? '').replace(/^Claude\s+/i, '').replace(/\s*\(.*\)$/, '');
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
        if (!model) {
            return null;
        }

        const modelDisplayName = typeof model === 'string'
            ? model
            : (model.display_name ?? model.id);

        if (!modelDisplayName) {
            return null;
        }

        const shortName = formatModelDisplayName(model);
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
