import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    HideableState,
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import {
    formatCost,
    resolveNumberFormat
} from '../utils/number-format';
import { getSessionCostSummary } from '../utils/session-cost';

import { isHidden } from './shared/hideable';
import { formatRawOrLabeledValue } from './shared/raw-or-labeled';

const LABEL = 'Cost: ';

const ZERO_HIDEABLE_STATE: HideableState = { key: 'zero', label: 'when cost is $0.00' };

export class SessionCostWidget implements Widget {
    getDefaultColor(): string { return 'green'; }
    getDescription(): string { return 'Shows the total session cost in USD'; }
    getDisplayName(): string { return 'Session Cost'; }
    getCategory(): string { return 'Session'; }
    getLabelPrefix(): string { return LABEL; }
    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return { displayText: this.getDisplayName() };
    }

    getHideableStates(): HideableState[] {
        return [ZERO_HIDEABLE_STATE];
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const format = resolveNumberFormat('cost', item, settings);
        if (context.isPreview) {
            const value = formatCost(2.45, format);
            return formatRawOrLabeledValue(item, this.getLabelPrefix(), value);
        }

        let totalCost = context.data?.cost?.total_cost_usd;
        let approximate = false;

        // Claude Code prices every message at Anthropic list prices, which is
        // wrong once the gateway routes to other models. All-Claude sessions
        // keep its number, which also covers calls the transcript never records.
        const transcriptPath = context.data?.transcript_path;
        const summary = transcriptPath ? getSessionCostSummary(transcriptPath) : null;
        if (summary && !summary.allClaude) {
            if (summary.hasUnknown) {
                approximate = true;
            } else {
                totalCost = summary.total;
            }
        }

        if (totalCost === undefined) {
            return null;
        }

        // Keep the zero-state threshold tied to the baseline cent precision,
        // independent of the selected display style or decimal override.
        const roundsToZeroCents = totalCost >= 0 && totalCost < 0.005;
        if (roundsToZeroCents && isHidden(item, ZERO_HIDEABLE_STATE.key)) {
            return null;
        }

        const formattedCost = `${formatCost(totalCost, format)}${approximate ? '~' : ''}`;
        return formatRawOrLabeledValue(item, this.getLabelPrefix(), formattedCost);
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
    supportsNumberFormat(): boolean { return true; }
}
