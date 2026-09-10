import {
    describe,
    expect,
    it
} from 'vitest';

import type { WidgetItem } from '../../types';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import { renderOsc8Link } from '../../utils/hyperlink';
import { DevServerWidget } from '../DevServer';

const ITEM: WidgetItem = { id: 'ds', type: 'dev-server' };

describe('DevServerWidget', () => {
    it('renders the full URL as the link text', () => {
        const out = new DevServerWidget().render(ITEM, { isPreview: true }, DEFAULT_SETTINGS);
        expect(out).toBe(renderOsc8Link('http://localhost:8000/', 'http://localhost:8000/'));
    });

    it('returns null without a transcript path', () => {
        expect(new DevServerWidget().render(ITEM, { data: {} }, DEFAULT_SETTINGS)).toBeNull();
    });
});
