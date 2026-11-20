import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import {
    formatPercent,
    resolveNumberFormat
} from '../utils/number-format';
import { getSessionPromptTokens } from '../utils/session-cost';

import { getCacheReadPercentage } from './shared/cache-metrics';
import { formatRawOrLabeledValue } from './shared/raw-or-labeled';

const LABEL = 'Cache Hit: ';

// Cache Hit Rate leaves input tokens out of the denominator, so a model that
// reports cache misses as input (every non-Claude one) shows 100% there.
export class SessionCacheHitWidget implements Widget {
    getDefaultColor(): string { return 'green'; }
    getDescription(): string { return 'Shows the session cache hit rate across the main transcript and its subagents: cache reads over input plus cache reads and writes'; }
    getDisplayName(): string { return 'Session Cache Hit'; }
    getCategory(): string { return 'Cache'; }
    getLabelPrefix(): string { return LABEL; }
    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return { displayText: this.getDisplayName() };
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const format = resolveNumberFormat('percent', item, settings);
        if (context.isPreview) {
            return formatRawOrLabeledValue(item, this.getLabelPrefix(), formatPercent(84.5, format));
        }

        const transcriptPath = context.data?.transcript_path;
        const tokens = transcriptPath ? getSessionPromptTokens(transcriptPath) : null;
        const percent = tokens && tokens.read > 0 ? getCacheReadPercentage(tokens) : null;
        if (percent === null) {
            return null;
        }

        return formatRawOrLabeledValue(item, this.getLabelPrefix(), formatPercent(percent, format));
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
    supportsNumberFormat(): boolean { return true; }
}
