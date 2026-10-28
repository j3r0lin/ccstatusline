import {
    describe,
    expect,
    it
} from 'vitest';

import type { WidgetItem } from '../../types';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import { renderOsc8Link } from '../../utils/hyperlink';
import {
    DevServerWidget,
    devServerLabel
} from '../DevServer';

const ITEM: WidgetItem = { id: 'ds', type: 'dev-server' };

describe('devServerLabel', () => {
    it('shows only the port for loopback dev servers', () => {
        expect(devServerLabel('http://localhost:8000/')).toBe(':8000');
        expect(devServerLabel('http://127.0.0.1:5173/')).toBe(':5173');
    });

    it('keeps the host when the URL has no port', () => {
        expect(devServerLabel('http://localhost/')).toBe('localhost');
    });

    it('falls back to the raw text when the URL does not parse', () => {
        expect(devServerLabel('not a url')).toBe('not a url');
    });
});

describe('DevServerWidget', () => {
    it('renders the port over the full address', () => {
        const out = new DevServerWidget().render(ITEM, { isPreview: true }, DEFAULT_SETTINGS);
        expect(out).toBe(renderOsc8Link('http://localhost:8000/', ':8000'));
    });

    it('returns null without a transcript path', () => {
        expect(new DevServerWidget().render(ITEM, { data: {} }, DEFAULT_SETTINGS)).toBeNull();
    });
});
