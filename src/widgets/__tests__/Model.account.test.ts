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
import { stripSgrCodes } from '../../utils/ansi';
import * as accountLabel from '../../utils/magpie-account-label';
import * as magpie from '../../utils/magpie-usage';
import {
    preRenderAllWidgets,
    renderStatusLine
} from '../../utils/renderer';
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

describe('ModelWidget provider label toggle', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(magpie, 'isMagpieGateway').mockReturnValue(true);
    });

    function renderWithAccount(account: magpie.MagpieAccount | undefined, accountCount: number | undefined, item: WidgetItem = ITEM): string | null {
        vi.spyOn(magpie, 'resolveSessionAccount').mockReturnValue(account);
        vi.spyOn(magpie, 'describeAccount').mockReturnValue(accountCount === undefined ? undefined : { providerAccountCount: accountCount });
        return new ModelWidget().render(item, CONTEXT, NO_COLOR);
    }

    it('shows the provider a routing group picked by default', () => {
        expect(renderWithAccount({ provider: 'codex', email: 'someone@gmail.com', routed: true }, 1)).toBe('Sonnet 5.5 @codex');
    });

    it('hides the provider label when the toggle is off', () => {
        const item: WidgetItem = { ...ITEM, metadata: { showProvider: 'false' } };
        expect(renderWithAccount({ provider: 'codex', email: 'someone@gmail.com', routed: true }, 1, item)).toBe('Sonnet 5.5');
    });

    it('still shows the account name when the provider has several accounts and the toggle is off', () => {
        const item: WidgetItem = { ...ITEM, metadata: { showProvider: 'false' } };
        expect(renderWithAccount({ provider: 'claude', email: 'platform2@inhand.com', routed: true }, 4, item)).toBe('Sonnet 5.5 @platform2');
    });

    it('keeps the label prefix and model name in compact output', () => {
        renderWithAccount({ provider: 'codex', routed: true }, 1);
        const item = { ...ITEM, rawValue: false };
        expect(new ModelWidget().renderCompact(item, CONTEXT, NO_COLOR)).toBe('Model: Sonnet 5.5');
    });

    it('keeps account names in compact output when several accounts need distinguishing', () => {
        renderWithAccount({ provider: 'claude', email: 'account@example.com', routed: true }, 4);
        expect(new ModelWidget().renderCompact(ITEM, CONTEXT, NO_COLOR)).toBe('Sonnet 5.5 @account');
    });

    it('hides the provider only on overflow and restores it when the line fits again', () => {
        renderWithAccount({ provider: 'codex', routed: true }, 1);
        const items: WidgetItem[] = [
            ITEM,
            { id: 'tail', type: 'custom-text', customText: 'tail' }
        ];
        const settings = { ...DEFAULT_SETTINGS, defaultPadding: '', defaultSeparator: ' | ', flexMode: 'full' as const };
        const renderAt = (terminalWidth: number): string => {
            const context = { ...CONTEXT, terminalWidth };
            const preRendered = preRenderAllWidgets([items], settings, context);
            return stripSgrCodes(renderStatusLine(items, settings, context, preRendered[0] ?? [], []));
        };
        const wide = renderAt(80);
        expect(wide).toContain('Sonnet 5.5 @codex');
        const narrow = renderAt(24);
        expect(narrow).toContain('Sonnet 5.5');
        expect(narrow).toContain('tail');
        expect(narrow).not.toContain('@codex');
        expect(narrow).not.toContain('...');
        expect(renderAt(80)).toBe(wide);
    });

    it('toggles the provider label metadata from the editor action', () => {
        const widget = new ModelWidget();
        const off = widget.handleEditorAction('toggle-provider-label', ITEM);
        expect(off?.metadata?.showProvider).toBe('false');
        const on = widget.handleEditorAction('toggle-provider-label', off ?? ITEM);
        expect(on?.metadata?.showProvider).toBe('true');
    });

    it('reports the provider label state in the editor display', () => {
        const widget = new ModelWidget();
        expect(widget.getEditorDisplay(ITEM).modifierText).toBeUndefined();
        expect(widget.getEditorDisplay({ ...ITEM, metadata: { showProvider: 'false' } }).modifierText).toBe('(provider label off)');
        expect(widget.getEditorDisplay({ ...ITEM, metadata: { effortColor: 'true', showProvider: 'false' } }).modifierText).toBe('(effort color, provider label off)');
    });
});
