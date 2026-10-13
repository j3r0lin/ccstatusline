import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import {
    describeAccount,
    isMagpieGateway,
    resolveSessionAccount
} from '../utils/magpie-usage';

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
        if (!isMagpieGateway()) {
            return null;
        }

        const model = context.data?.model;
        const account = resolveSessionAccount(context.data?.session_id, typeof model === 'string' ? model : model?.id);
        if (!account) {
            return null;
        }

        const details = describeAccount(account);
        // An unknown count is treated as several, so a possibly relevant account is not hidden.
        const hasSeveralAccounts = (details?.providerAccountCount ?? 2) > 1;
        if (hasSeveralAccounts) {
            const name = details?.alias ?? account.email?.split('@')[0] ?? account.provider;
            return formatRawOrLabeledValue(item, this.getLabelPrefix(), name);
        }
        // With one account, the name only matters when a routing group could have picked another provider.
        return account.routed ? formatRawOrLabeledValue(item, this.getLabelPrefix(), account.provider) : null;
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}
