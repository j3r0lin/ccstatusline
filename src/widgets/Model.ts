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
    resolveMagpieAccountLabel,
    resolveMagpieModel
} from '../utils/magpie-account-label';
import {
    detectModelMismatch,
    getLastRequestedModel,
    isSameRequestedModel
} from '../utils/model-mismatch';
import { formatModelName } from '../utils/model-names';
import {
    colorizeModelName,
    resolveThinkingEffort
} from '../utils/thinking-effort';

import { getLabel } from './shared/raw-or-labeled';

const RESET = '\x1b[0m';

function isEffortColor(item: WidgetItem): boolean {
    return item.metadata?.effortColor === 'true';
}

// The magpie provider label a routing group picked defaults to on; only an
// explicit 'false' hides it.
function showsProviderLabel(item: WidgetItem): boolean {
    return item.metadata?.showProvider !== 'false';
}

interface ModelInfo {
    id?: string;
    display_name?: string;
}

function formatModelDisplayName(model: string | ModelInfo): string {
    return formatModelName(typeof model === 'string' ? model : (model.id ?? model.display_name ?? ''));
}

const LABEL = 'Model: ';

export class ModelWidget implements Widget {
    getDefaultColor(): string { return 'cyan'; }
    getDescription(): string { return 'Displays the Claude model name (e.g., Claude 3.5 Sonnet).\nOptionally colors the name by thinking effort: low=gold, medium=green, high=lavender, xhigh=purple, max=rainbow.'; }
    getDisplayName(): string { return 'Model'; }
    getCategory(): string { return 'Core'; }
    getLabelPrefix(): string { return LABEL; }
    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        const modifiers = [
            isEffortColor(item) ? 'effort color' : null,
            showsProviderLabel(item) ? null : 'provider label off'
        ].filter((modifier): modifier is string => modifier !== null);
        return {
            displayText: this.getDisplayName(),
            modifierText: modifiers.length > 0 ? `(${modifiers.join(', ')})` : undefined
        };
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        if (action === 'toggle-effort-color') {
            return {
                ...item,
                metadata: {
                    ...(item.metadata ?? {}),
                    effortColor: isEffortColor(item) ? 'false' : 'true'
                }
            };
        }
        if (action === 'toggle-provider-label') {
            return {
                ...item,
                metadata: {
                    ...(item.metadata ?? {}),
                    showProvider: showsProviderLabel(item) ? 'false' : 'true'
                }
            };
        }
        return null;
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

        const magpieModel = resolveMagpieModel(context);
        const modelName = magpieModel ? formatModelName(magpieModel) : formatModelDisplayName(model);
        const hasFastSuffix = /\s+Fast$/i.test(modelName);
        const fast = context.data?.fast_mode === true || hasFastSuffix;
        const shortName = hasFastSuffix ? modelName.replace(/\s+Fast$/i, '') : modelName;
        const colored = effortColor
            ? colorizeModelName(shortName, resolveThinkingEffort(context), colorLevel)
            : null;
        // After a model switch the transcript still describes the previous request,
        // so a mismatch it shows says nothing about the model now displayed.
        const lastRequested = typeof model === 'string' ? undefined : getLastRequestedModel(context.data?.transcript_path);
        const switchedSinceLastRequest = lastRequested !== undefined && !isSameRequestedModel(lastRequested, typeof model === 'string' ? model : (model.id ?? ''));
        const returnedModel = typeof model === 'string' || switchedSinceLastRequest
            ? null
            : detectModelMismatch(magpieModel ?? model.id, context.data?.transcript_path);
        const mismatch = returnedModel ? `→ ${formatModelName(returnedModel)}` : null;
        const accountLabel = resolveMagpieAccountLabel(context, { showProvider: showsProviderLabel(item) });
        const account = accountLabel ? `@${accountLabel}` : null;

        if (settings.colorLevel === 0) {
            const parts = [shortName, ...(fast ? ['↯'] : []), ...(mismatch ? [mismatch] : []), ...(account ? [account] : [])];
            return this.compose(item, parts.join(' '), false, colorLevel);
        }
        if (!fast && !mismatch && !account) {
            return this.compose(item, colored ?? shortName, colored !== null, colorLevel);
        }

        const nameColor = getColorAnsiCode(item.color ?? this.getDefaultColor(), colorLevel, false);
        let value = colored ?? `${nameColor}${shortName}\x1b[39m`;
        if (mismatch) {
            value = `\x1b[9m${value}\x1b[29m`;
        }
        if (fast) {
            // 使用 Claude Code 2.1.294 深色主题的 Fast mode 配色。
            const iconColor = getColorAnsiCode(colorLevel === 'truecolor' ? 'hex:FF7814' : colorLevel === 'ansi256' ? 'ansi256:208' : 'brightRed', colorLevel, false);
            value += ` ${iconColor}↯\x1b[39m`;
        }
        if (mismatch) {
            const warnColor = getColorAnsiCode(colorLevel === 'truecolor' ? 'hex:FFB000' : colorLevel === 'ansi256' ? 'ansi256:214' : 'yellow', colorLevel, false);
            value += ` ${warnColor}${mismatch}\x1b[39m`;
        }
        if (account) {
            const accountColor = getColorAnsiCode('brightMagenta', colorLevel, false);
            value += ` ${accountColor}${account}\x1b[39m`;
        }
        return this.compose(item, value, true, colorLevel);
    }

    renderCompact(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        return this.render({
            ...item,
            metadata: { ...item.metadata, showProvider: 'false' }
        }, context, settings);
    }

    // Builds the final output. When the name carries inline effort colors, the
    // The label keeps the widget's base color so only the value is recolored.
    private compose(item: WidgetItem, value: string, valueIsColored: boolean, colorLevel: ReturnType<typeof getColorLevelString>): string {
        if (item.rawValue) {
            return value;
        }
        const label = getLabel(item, this.getLabelPrefix());
        if (!valueIsColored) {
            return `${label}${value}`;
        }
        const labelCode = getColorAnsiCode(item.color ?? this.getDefaultColor(), colorLevel, false);
        return `${labelCode}${label}${RESET}${value}`;
    }

    getCustomKeybinds(): CustomKeybind[] {
        return [
            { key: 'e', label: '(e)ffort color toggle', action: 'toggle-effort-color' },
            { key: 'p', label: '(p)rovider label toggle', action: 'toggle-provider-label' }
        ];
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
    usesInlineColors(item: WidgetItem): boolean { return true; }
}
