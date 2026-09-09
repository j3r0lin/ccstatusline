import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import {
    collectDevServerUrls,
    extractDevServerUrl,
    sidecarPathFromTranscript
} from '../dev-servers';

describe('extractDevServerUrl', () => {
    it('takes Local: over stack-frame localhost URLs', () => {
        const log = `
  VITE v8.2.2   beta   ready in 350 ms

  ➜  Local:   http://localhost:8000/
  ➜  Network: use --host to expose
    at JsonService.postForm (http://localhost:8000/node_modules/.vite/deps/oidc-client-ts.js?v=f34ca04d:711:26)
`;
        expect(extractDevServerUrl(log)).toBe('http://localhost:8000/');
    });

    it('keeps localhost instead of rewriting to 127.0.0.1', () => {
        expect(extractDevServerUrl('  ➜  Local:   http://localhost:8000/\n')).toBe('http://localhost:8000/');
    });

    it('uses the Local port after vite bumps it', () => {
        const log = `
Port 8000 is in use, trying another one...
  ➜  Local:   http://localhost:8001/
`;
        expect(extractDevServerUrl(log)).toBe('http://localhost:8001/');
    });

    it('falls back to a bare loopback URL when Local: is missing', () => {
        expect(extractDevServerUrl('listening on http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173/');
    });

    it('ignores localhost URLs that are not the origin', () => {
        expect(extractDevServerUrl('at x (http://localhost:8000/node_modules/foo.js:1:1)')).toBeNull();
    });

    it('strips SGR codes before matching a colored Local: line', () => {
        const log = '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m8001\x1b[22m/\x1b[39m';
        expect(extractDevServerUrl(log)).toBe('http://localhost:8001/');
    });

    it('strips SGR codes before matching a colored bare loopback URL', () => {
        expect(extractDevServerUrl('\x1b[36mhttp://127.0.0.1:\x1b[1m5173\x1b[22m/\x1b[39m')).toBe('http://127.0.0.1:5173/');
    });
});

describe('sidecarPathFromTranscript', () => {
    it('puts the sidecar in the session directory next to the parent jsonl', () => {
        expect(sidecarPathFromTranscript('/proj/abc.jsonl')).toBe('/proj/abc/dev-servers.json');
    });

    it('maps a subagent transcript to the parent session sidecar', () => {
        expect(sidecarPathFromTranscript('/proj/abc/subagents/agent-x.jsonl')).toBe('/proj/abc/dev-servers.json');
    });
});

describe('collectDevServerUrls', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-servers-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reads the URL from a redirect log when the CC output file is empty', () => {
        const session = path.join(tmpDir, 'sess.jsonl');
        fs.writeFileSync(session, '');
        const sessionDir = path.join(tmpDir, 'sess');
        fs.mkdirSync(sessionDir);
        const log = path.join(tmpDir, 'devserver.log');
        const output = path.join(tmpDir, 'b7xpaq7bj.output');
        fs.writeFileSync(output, '');
        fs.writeFileSync(log, '  ➜  Local:   http://localhost:8000/\n');
        fs.writeFileSync(path.join(sessionDir, 'dev-servers.json'), JSON.stringify({
            servers: [{
                id: 'b7xpaq7bj',
                command: 'vite > /tmp/devserver.log 2>&1',
                outputFile: output,
                redirect: log,
                ts: 1
            }]
        }));

        expect(collectDevServerUrls(session, {
            isUrlReachable: () => true
        })).toEqual(['http://localhost:8000/']);
    });

    it('shows a reachable URL even when file-opener probing would fail', () => {
        const session = path.join(tmpDir, 'sess.jsonl');
        fs.writeFileSync(session, '');
        const sessionDir = path.join(tmpDir, 'sess');
        fs.mkdirSync(sessionDir);
        const log = path.join(tmpDir, 'devserver.log');
        fs.writeFileSync(log, '  ➜  Local:   http://localhost:8000/\n');
        fs.writeFileSync(path.join(sessionDir, 'dev-servers.json'), JSON.stringify({
            servers: [{
                id: 'live',
                command: 'vite',
                outputFile: log,
                redirect: log,
                ts: 1
            }]
        }));

        expect(collectDevServerUrls(session, {
            isUrlReachable: () => true
        })).toEqual(['http://localhost:8000/']);
    });

    it('hides an unreachable URL', () => {
        const session = path.join(tmpDir, 'sess.jsonl');
        fs.writeFileSync(session, '');
        const sessionDir = path.join(tmpDir, 'sess');
        fs.mkdirSync(sessionDir);
        const log = path.join(tmpDir, 'devserver.log');
        fs.writeFileSync(log, '  ➜  Local:   http://localhost:8000/\n');
        fs.writeFileSync(path.join(sessionDir, 'dev-servers.json'), JSON.stringify({
            servers: [{
                id: 'dead',
                command: 'vite',
                outputFile: log,
                redirect: log,
                ts: 1
            }]
        }));

        expect(collectDevServerUrls(session, {
            isUrlReachable: () => false
        })).toEqual([]);
    });

    it('finds Local: at the head of a log whose tail is only HMR noise', () => {
        const session = path.join(tmpDir, 'sess.jsonl');
        fs.writeFileSync(session, '');
        const sessionDir = path.join(tmpDir, 'sess');
        fs.mkdirSync(sessionDir);
        const log = path.join(tmpDir, 'devserver-wt2.log');
        const noise = '10:00:00 PM [vite] (client) hmr update /src/App.tsx\n    at Foo (http://localhost:8001/@fs/x/y.tsx:1:1)\n';
        fs.writeFileSync(log, `Port 8000 is in use, trying another one...\n\n  ➜  Local:   http://localhost:8001/\n${noise.repeat(2000)}`);
        expect(fs.statSync(log).size).toBeGreaterThan(64 * 1024);
        fs.writeFileSync(path.join(sessionDir, 'dev-servers.json'), JSON.stringify({
            servers: [{ id: 'wt2', command: 'nohup pnpm dev > x.log &', outputFile: log, redirect: log, ts: 1 }]
        }));

        expect(collectDevServerUrls(session, { isUrlReachable: () => true })).toEqual(['http://localhost:8001/']);
    });

    it('keeps the newest two distinct URLs', () => {
        const session = path.join(tmpDir, 'sess.jsonl');
        fs.writeFileSync(session, '');
        const sessionDir = path.join(tmpDir, 'sess');
        fs.mkdirSync(sessionDir);
        const a = path.join(tmpDir, 'a.log');
        const b = path.join(tmpDir, 'b.log');
        const c = path.join(tmpDir, 'c.log');
        fs.writeFileSync(a, 'Local: http://localhost:8000/\n');
        fs.writeFileSync(b, 'Local: http://localhost:8001/\n');
        fs.writeFileSync(c, 'Local: http://localhost:8002/\n');
        fs.writeFileSync(path.join(sessionDir, 'dev-servers.json'), JSON.stringify({
            servers: [
                { id: 'a', command: 'a', outputFile: a, redirect: a, ts: 1 },
                { id: 'b', command: 'b', outputFile: b, redirect: b, ts: 2 },
                { id: 'c', command: 'c', outputFile: c, redirect: c, ts: 3 }
            ]
        }));

        expect(collectDevServerUrls(session, { isUrlReachable: () => true })).toEqual([
            'http://localhost:8002/',
            'http://localhost:8001/'
        ]);
    });
});
