import type { RenderContext } from '../types/RenderContext';

import {
    describeAccount,
    isMagpieGateway,
    resolveSessionAccount,
    type MagpieAccount
} from './magpie-usage';

function resolveBehindMagpie(context: RenderContext): MagpieAccount | undefined {
    if (!isMagpieGateway()) {
        return undefined;
    }
    const model = context.data?.model;
    return resolveSessionAccount(context.data?.session_id, typeof model === 'string' ? model : model?.id);
}

// The model magpie recorded for the session's latest turn; undefined outside magpie or before its first turn.
export function resolveMagpieModel(context: RenderContext): string | undefined {
    return resolveBehindMagpie(context)?.model;
}

// Behind the magpie gateway, names the account serving the session when its
// provider has several, or the provider a routing group picked; null elsewhere.
// A caller that already surfaces the served model name can hide the provider
// label via showProvider, which only affects the routing-group case.
export function resolveMagpieAccountLabel(context: RenderContext, options?: { showProvider?: boolean }): string | null {
    const account = resolveBehindMagpie(context);
    if (!account) {
        return null;
    }

    const details = describeAccount(account);
    // An unknown count is treated as several, so a possibly relevant account is not hidden.
    const hasSeveralAccounts = (details?.providerAccountCount ?? 2) > 1;
    if (hasSeveralAccounts) {
        return details?.alias ?? account.email?.split('@')[0] ?? account.provider;
    }
    // With one account, the name only matters when a routing group could have picked another provider.
    return account.routed && options?.showProvider !== false ? account.provider : null;
}
