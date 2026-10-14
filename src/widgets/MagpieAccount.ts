import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import { resolveMagpieAccountLabel } from '../utils/magpie-account-label';

import { formatRawOrLabeledValue } from './shared/raw-or-labeled';

const LABEL = 'Account: ';

export class MagpieAccountWidget implements Widget {
    getDefaultColor(): string { return 'blue'; }
    getDescription(): string { return 'Through the local magpie gateway, names the account serving this session when its provider has several, or the provider a routing group picked; hidden elsewhere'; }
    getDisplayName(): string { return 'Magpie Account'; }
    getCategory(): string { return 'Session'; }
    getLabelPrefix(): string { return LABEL; }
    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return { displayText: this.getDisplayName() };
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        if (context.isPreview) {
            return formatRawOrLabeledValue(item, this.getLabelPrefix(), 'you');
        }
        const label = resolveMagpieAccountLabel(context);
        return label ? formatRawOrLabeledValue(item, this.getLabelPrefix(), label) : null;
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
