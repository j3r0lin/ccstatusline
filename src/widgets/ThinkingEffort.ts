import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    CustomKeybind,
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import {
    type ResolvedThinkingEffort,
    type TranscriptThinkingEffort
} from '../utils/jsonl';
import { resolveThinkingEffort } from '../utils/thinking-effort';

export type ThinkingEffortLevel = TranscriptThinkingEffort;

const EFFORT_ABBREVIATIONS: Record<TranscriptThinkingEffort, string> = {
    low: 'L',
    medium: 'M',
    high: 'H',
    xhigh: 'XH',
    max: 'MAX'
};

function isAbbreviated(item: WidgetItem): boolean {
    return item.metadata?.abbreviate === 'true';
}

function formatEffort(resolved: ResolvedThinkingEffort | null, abbreviate: boolean): string {
    if (!resolved) {
        return 'default';
    }
    if (!resolved.known) {
        return `${resolved.value}?`;
    }
    return abbreviate
        ? EFFORT_ABBREVIATIONS[resolved.value as TranscriptThinkingEffort]
        : resolved.value;
}

export class ThinkingEffortWidget implements Widget {
    getDefaultColor(): string { return 'magenta'; }
    getDescription(): string { return 'Displays the current thinking effort level (low, medium, high, xhigh, max).\nClaude Code reports Ultracode as xhigh in status line data; Ultracode is not exposed as a separate effort level.\nUnknown levels are shown with a trailing "?" (e.g. "super-max?").\nMay be incorrect when multiple Claude Code sessions are running due to current Claude Code limitations.'; }
    getDisplayName(): string { return 'Thinking Effort'; }
    getCategory(): string { return 'Core'; }
    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return {
            displayText: this.getDisplayName(),
            modifierText: isAbbreviated(item) ? '(abbreviated)' : undefined
        };
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        if (action !== 'toggle-abbreviate') {
            return null;
        }

        return {
            ...item,
            metadata: {
                ...(item.metadata ?? {}),
                abbreviate: isAbbreviated(item) ? 'false' : 'true'
            }
        };
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const abbreviate = isAbbreviated(item);

        if (context.isPreview) {
            const preview = abbreviate ? 'H' : 'high';
            return item.rawValue ? preview : `Thinking: ${preview}`;
        }

        const effort = formatEffort(resolveThinkingEffort(context), abbreviate);
        return item.rawValue ? effort : `Thinking: ${effort}`;
    }

    getCustomKeybinds(): CustomKeybind[] {
        return [
            { key: 'a', label: '(a)bbreviate toggle', action: 'toggle-abbreviate' }
        ];
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
