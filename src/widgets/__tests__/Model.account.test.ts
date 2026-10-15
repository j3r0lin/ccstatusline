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
import * as accountLabel from '../../utils/magpie-account-label';
import { ModelWidget } from '../Model';

const ITEM: WidgetItem = { id: 'model', type: 'model', rawValue: true };
const CONTEXT: RenderContext = { data: { model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' }, session_id: 'session' } };
const NO_COLOR = { ...DEFAULT_SETTINGS, colorLevel: 0 as const };

describe('ModelWidget account suffix', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('appends the account name after the model name', () => {
        vi.spyOn(accountLabel, 'resolveMagpieAccountLabel').mockReturnValue('platform2');
        expect(new ModelWidget().render(ITEM, CONTEXT, NO_COLOR)).toBe('Sonnet 5.5 @platform2');
    });

    it('shows only the model name when there is no account to name', () => {
        vi.spyOn(accountLabel, 'resolveMagpieAccountLabel').mockReturnValue(null);
        expect(new ModelWidget().render(ITEM, CONTEXT, NO_COLOR)).toBe('Sonnet 5.5');
    });

    it('keeps the account name in colored output', () => {
        vi.spyOn(accountLabel, 'resolveMagpieAccountLabel').mockReturnValue('platform2');
        const output = new ModelWidget().render(ITEM, CONTEXT, DEFAULT_SETTINGS) ?? '';
        expect(output).toContain('@platform2');
        expect(output).toContain('Sonnet 5.5');
    });
});
