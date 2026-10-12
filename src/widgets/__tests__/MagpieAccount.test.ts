import {
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type {
    RenderContext,
    WidgetItem
} from '../../types';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import * as magpie from '../../utils/magpie-usage';
import { MagpieAccountWidget } from '../MagpieAccount';

const ITEM: WidgetItem = { id: 'magpie-account', type: 'magpie-account', rawValue: true };
const CONTEXT: RenderContext = { data: { model: { id: 'any-model' }, session_id: 'session' } };

function render(account: magpie.MagpieAccount | undefined, accountCount: number | undefined, behindMagpie = true, alias?: string): string | null {
    vi.spyOn(magpie, 'isMagpieGateway').mockReturnValue(behindMagpie);
    vi.spyOn(magpie, 'resolveSessionAccount').mockReturnValue(account);
    vi.spyOn(magpie, 'describeAccount').mockReturnValue(accountCount === undefined ? undefined : { providerAccountCount: accountCount, alias });
    return new MagpieAccountWidget().render(ITEM, CONTEXT, DEFAULT_SETTINGS);
}

describe('MagpieAccountWidget', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('shows the account name when the provider has several accounts', () => {
        expect(render({ provider: 'claude', email: 'platform2@inhand.com' }, 4)).toBe('platform2');
        expect(render({ provider: 'claude', email: 'platform2@inhand.com', routed: true }, 4)).toBe('platform2');
    });

    it('prefers the account alias over the email name', () => {
        expect(render({ provider: 'claude', email: 'platform2@inhand.com' }, 4, true, 'p2')).toBe('p2');
    });

    it('shows the provider when a routing group picked a single-account provider', () => {
        expect(render({ provider: 'codex', email: 'someone@gmail.com', routed: true }, 1)).toBe('codex');
    });

    it('shows nothing for a fixed-provider model whose provider has one account', () => {
        expect(render({ provider: 'grok', email: 'someone@gmail.com' }, 1)).toBeNull();
    });

    it('shows the account name when the account count is not known yet', () => {
        expect(render({ provider: 'claude', email: 'chenjian@inhand.com' }, undefined)).toBe('chenjian');
    });

    it('shows nothing before the session is routed or outside the magpie gateway', () => {
        expect(render(undefined, 4)).toBeNull();
        expect(render({ provider: 'claude', email: 'chenjian@inhand.com' }, 4, false)).toBeNull();
    });
});
