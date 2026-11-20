import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
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

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A transcript whose session directory holds a sidecar and a resolved cache. */
function sessionWithCache(cache: { records: Record<string, unknown>; discovered?: unknown[]; portsCheckedAt?: number }): string {
    const dir = mkdtempSync(join(tmpdir(), 'dev-server-widget-'));
    tempDirs.push(dir);
    const transcript = join(dir, 'sess.jsonl');
    writeFileSync(transcript, '');
    const sessionDir = join(dir, 'sess');
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, 'dev-servers.json'), JSON.stringify({ servers: [{ id: 'a', command: 'pnpm dev', outputFile: '/tasks/a.output', ts: 1 }] }));
    writeFileSync(join(sessionDir, 'dev-servers-resolved.json'), JSON.stringify({
        records: cache.records,
        discovered: cache.discovered ?? [],
        ports: [],
        portsCheckedAt: cache.portsCheckedAt ?? Date.now()
    }));
    return transcript;
}

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

    it('renders the port the last refresh resolved', () => {
        const transcript = sessionWithCache({ records: { a: { pid: process.pid, url: 'http://localhost:8123/', mtimes: [] } } });
        const out = new DevServerWidget().render(
            ITEM,
            { data: { transcript_path: transcript } },
            DEFAULT_SETTINGS
        );
        expect(out).toBe(renderOsc8Link('http://localhost:8123/', ':8123'));
    });

    it('renders nothing once the resolved process is gone', () => {
        const transcript = sessionWithCache({ records: { a: { pid: 2_147_483_646, url: 'http://localhost:8123/', mtimes: [] } } });
        const out = new DevServerWidget().render(
            ITEM,
            { data: { transcript_path: transcript } },
            DEFAULT_SETTINGS
        );
        expect(out).toBeNull();
    });
});
