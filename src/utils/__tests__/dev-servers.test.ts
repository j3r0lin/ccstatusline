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

import type {
    DevServerRecord,
    ListeningProcess,
    ServerCache,
    ServerEndpoint
} from '../dev-servers';
import {
    announcedPort,
    collectDevServerUrls,
    createServerResolver,
    endpointUrl,
    extractDevServerUrl,
    parseEndpoints,
    parseListeningPorts,
    sessionIdFromTranscript,
    sessionOwnedFiles,
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

describe('findServerEndpoints', () => {
    it('reads the port off the process that both holds the log and listens', () => {
        // What lsof -Fpn prints for a pnpm wrapper that only holds the log and a
        // vite that holds it and listens.
        const out = [
            'p100', 'f1', 'n/jobs/a/dev.log',
            'p200', 'f1', 'n/jobs/a/dev.log', 'f3', 'n127.0.0.1:5173',
            'p300', 'f5', 'n192.168.1.9:443'
        ].join('\n');
        const found = parseEndpoints(out, ['/jobs/a/dev.log']);
        expect(found.get('/jobs/a/dev.log')).toEqual({ pid: 200, ports: [5173] });
    });

    it('takes a wildcard bind, which localhost still reaches', () => {
        const out = ['p200', 'f1', 'n/jobs/a/dev.log', 'f3', 'n*:5173'].join('\n');
        expect(parseEndpoints(out, ['/jobs/a/dev.log']).get('/jobs/a/dev.log')?.ports).toEqual([5173]);
    });

    it('skips a bind on one specific interface, which localhost does not reach', () => {
        const out = ['p200', 'f1', 'n/jobs/a/dev.log', 'f3', 'n192.168.1.9:5173'].join('\n');
        expect(parseEndpoints(out, ['/jobs/a/dev.log']).size).toBe(0);
    });

    it('finds nothing for a log whose holders all stopped listening', () => {
        const out = ['p100', 'f1', 'n/jobs/a/dev.log'].join('\n');
        expect(parseEndpoints(out, ['/jobs/a/dev.log']).size).toBe(0);
    });
});

describe('parseListeningPorts', () => {
    it('reads the port off a macOS netstat address, where the port comes last', () => {
        const out = [
            'tcp4  0  0  127.0.0.1.8000    *.*  LISTEN',
            'tcp4  0  0  *.5173            *.*  LISTEN',
            'tcp6  0  0  ::1.4173          *.*  LISTEN',
            'tcp4  0  0  192.168.1.9.443   *.*  LISTEN',
            'tcp4  0  0  127.0.0.1.8000    127.0.0.1.51234  ESTABLISHED'
        ].join('\n');
        expect(parseListeningPorts(out)).toEqual([4173, 5173, 8000]);
    });

    it('has nothing to report when nothing listens', () => {
        expect(parseListeningPorts('tcp4  0  0  *.*  *.*  CLOSED')).toEqual([]);
    });
});

describe('sessionOwnedFiles', () => {
    const session = '622410f3-1752-4b96-9a95-bddd6fe13ad8';

    it('claims a file under the session task directory', () => {
        const f = `/private/tmp/claude-501/-Users-x/${session}/tasks/bwforkzmo.output`;
        expect(sessionOwnedFiles(['/dev/null', f], session)).toEqual([f]);
    });

    it('claims a file under the job directory named after the session', () => {
        const f = '/Users/x/.claude/jobs/622410f3/tmp/devserver.log';
        expect(sessionOwnedFiles([f], session)).toEqual([f]);
    });

    it('claims nothing when the paths belong to no session it can name', () => {
        expect(sessionOwnedFiles(['/private/tmp/my-own-evidence/dev.log'], session)).toEqual([]);
    });

    it('claims nothing from another session', () => {
        expect(sessionOwnedFiles(['/Users/x/.claude/jobs/66729235/tmp/dev.log'], session)).toEqual([]);
    });
});

describe('announcedPort', () => {
    it('takes the port the log announced when the process has it open', () => {
        expect(announcedPort('http://localhost:8000/', [8000, 24678])).toBe(8000);
    });

    it('refuses a port the log never announced', () => {
        // agent-browser parked in the session directory, listening on an
        // ephemeral port and announcing nothing.
        expect(announcedPort(null, [58280])).toBeNull();
    });

    it('refuses a log whose address is not among the open ports', () => {
        expect(announcedPort('http://localhost:8000/', [58280])).toBeNull();
    });
});

describe('sessionIdFromTranscript', () => {
    it('reads the session id off the transcript name', () => {
        expect(sessionIdFromTranscript('/proj/abc-123.jsonl')).toBe('abc-123');
    });

    it('reads the parent session id off a subagent transcript', () => {
        expect(sessionIdFromTranscript('/proj/abc-123/subagents/agent-x.jsonl')).toBe('abc-123');
    });
});

describe('endpointUrl', () => {
    it('keeps the scheme and host from the log and takes the port from the kernel', () => {
        expect(endpointUrl('https://localhost:8000/', [5173])).toBe('https://localhost:5173/');
    });

    it('prefers the port the log named when that port is one of the open ones', () => {
        expect(endpointUrl('http://localhost:8000/', [24678, 8000])).toBe('http://localhost:8000/');
    });

    it('falls back to a plain loopback URL when the log said nothing', () => {
        expect(endpointUrl(null, [5173])).toBe('http://localhost:5173/');
    });

    it('has no URL to give when nothing is listening', () => {
        expect(endpointUrl('http://localhost:8000/', [])).toBeNull();
    });
});

describe('createServerResolver', () => {
    const log = '/jobs/a/dev.log';
    const record: DevServerRecord = {
        id: 'a',
        command: `pnpm dev > ${log} 2>&1`,
        outputFile: '/tasks/a.output',
        redirect: log,
        ts: 1
    };

    function resolver(over: {
        cache?: ServerCache['records'];
        endpoints?: Map<string, ServerEndpoint> | null;
        alivePids?: number[];
        written?: ServerCache[];
        declared?: string | null;
    }) {
        const lookups: string[][] = [];
        const instance = createServerResolver('/proj/sess.jsonl', [record], {
            readServerCache: () => ({ records: over.cache ?? {}, discovered: [], ports: [] }),
            writeServerCache: (_path: string, cache: ServerCache) => { over.written?.push(cache); },
            findServerEndpoints: (paths: string[]) => {
                lookups.push(paths);
                return 'endpoints' in over ? over.endpoints ?? null : new Map();
            },
            isPidAlive: (pid: number) => (over.alivePids ?? []).includes(pid),
            listeningPorts: () => [],
            findListeningProcesses: () => [],
            readDevServerLog: () => ('declared' in over ? over.declared ?? null : 'http://localhost:8000/')
        });
        return { ...instance, lookups };
    }

    it('resolves a record to the port its own process is listening on', () => {
        const r = resolver({ endpoints: new Map([[log, { pid: 200, ports: [5173] }]]) });
        expect(r.urlFor(record)).toBe('http://localhost:5173/');
    });

    it('resolves to nothing once no process serves that log', () => {
        const r = resolver({ endpoints: new Map() });
        expect(r.urlFor(record)).toBeNull();
    });

    // A plain `pnpm dev` in the background carries no redirect of its own, so
    // the harness output file is the only fd the server holds.
    it('resolves through the harness output file too', () => {
        const r = resolver({ endpoints: new Map([['/tasks/a.output', { pid: 200, ports: [5173] }]]) });
        expect(r.urlFor(record)).toBe('http://localhost:5173/');
    });

    it('resolves a record that has only a harness output file', () => {
        const r = resolver({ endpoints: new Map([['/tasks/a.output', { pid: 200, ports: [5173] }]]) });
        const noRedirect: DevServerRecord = {
            id: 'a',
            command: 'pnpm dev',
            outputFile: '/tasks/a.output',
            ts: 1
        };
        expect(r.urlFor(noRedirect)).toBe('http://localhost:5173/');
    });

    it('takes the log at its word for a record with nothing to recognise it by', () => {
        const r = resolver({ endpoints: new Map() });
        expect(r.urlFor({ ...record, redirect: '/dev/null', outputFile: '/dev/null' })).toBe('http://localhost:8000/');
        expect(r.lookups).toEqual([]);
    });

    it('takes the log at its word when the kernel cannot be asked', () => {
        const r = resolver({ endpoints: null });
        expect(r.urlFor(record)).toBe('http://localhost:8000/');
    });

    it('reuses a cached URL while its pid is alive, without asking again', () => {
        const r = resolver({
            cache: { a: { pid: 200, url: 'http://localhost:5173/', mtimes: [-1, -1] } },
            alivePids: [200]
        });
        expect(r.urlFor(record)).toBe('http://localhost:5173/');
        expect(r.lookups).toEqual([]);
    });

    it('asks again once the cached pid is gone and the log has been written to since', () => {
        const r = resolver({
            cache: { a: { pid: 200, url: 'http://localhost:5173/', mtimes: [999, 999] } },
            endpoints: new Map([[log, { pid: 300, ports: [4173] }]])
        });
        expect(r.urlFor(record)).toBe('http://localhost:4173/');
        expect(r.lookups).toEqual([[log, '/tasks/a.output']]);
    });

    it('stays resolved as gone while nothing writes to the log', () => {
        const r = resolver({
            cache: { a: { pid: 200, url: null, mtimes: [-1, -1] } },
            endpoints: new Map([[log, { pid: 200, ports: [5173] }]])
        });
        expect(r.urlFor(record)).toBeNull();
        expect(r.lookups).toEqual([]);
    });

    it('records what it learned so the next render can skip the lookup', () => {
        const written: ServerCache[] = [];
        const r = resolver({ endpoints: new Map([[log, { pid: 200, ports: [5173] }]]), written });
        r.urlFor(record);
        r.flush();
        expect(written[0]?.records.a).toMatchObject({ pid: 200, url: 'http://localhost:5173/' });
    });

    it('writes nothing when every answer came from the cache', () => {
        const written: ServerCache[] = [];
        const r = resolver({
            cache: { a: { pid: 200, url: 'http://localhost:5173/', mtimes: [-1, -1] } },
            alivePids: [200],
            written
        });
        r.urlFor(record);
        r.flush();
        expect(written).toEqual([]);
    });
});

describe('createServerResolver discovery', () => {
    const SESSION = '/proj/622410f3-1752-4b96-9a95-bddd6fe13ad8.jsonl';
    const owned = '/Users/x/.claude/jobs/622410f3/tmp/devserver.log';

    function resolver(over: {
        cache?: ServerCache;
        ports?: number[] | null;
        processes?: ListeningProcess[] | null;
        alivePids?: number[];
        written?: ServerCache[];
    }) {
        let scans = 0;
        const instance = createServerResolver(SESSION, [], {
            readServerCache: () => over.cache ?? { records: {}, discovered: [], ports: [] },
            writeServerCache: (_path: string, cache: ServerCache) => { over.written?.push(cache); },
            isPidAlive: (pid: number) => (over.alivePids ?? []).includes(pid),
            listeningPorts: () => ('ports' in over ? over.ports ?? null : []),
            findListeningProcesses: () => { scans++; return 'processes' in over ? over.processes ?? null : []; },
            readDevServerLog: () => 'http://localhost:8000/'
        });
        return {
            ...instance,
            scans: () => scans
        };
    }

    it('finds a server the sidecar never recorded', () => {
        const r = resolver({
            ports: [8000],
            processes: [{ pid: 300, ports: [8000], files: ['/dev/null', owned] }]
        });
        expect(r.discover()).toEqual(['http://localhost:8000/']);
    });

    it('leaves another session\'s server alone', () => {
        const r = resolver({
            ports: [8000],
            processes: [{ pid: 300, ports: [8000], files: ['/Users/x/.claude/jobs/66729235/tmp/dev.log'] }]
        });
        expect(r.discover()).toEqual([]);
    });

    it('skips the scan while the same ports are open and the known pid is alive', () => {
        const r = resolver({
            cache: { records: {}, discovered: [{ pid: 300, url: 'http://localhost:8000/' }], ports: [8000] },
            ports: [8000],
            alivePids: [300]
        });
        expect(r.discover()).toEqual(['http://localhost:8000/']);
        expect(r.scans()).toBe(0);
    });

    it('skips the scan when a port merely went away', () => {
        const r = resolver({
            cache: { records: {}, discovered: [{ pid: 300, url: 'http://localhost:8000/' }], ports: [8000, 58280] },
            ports: [8000],
            alivePids: [300]
        });
        expect(r.discover()).toEqual(['http://localhost:8000/']);
        expect(r.scans()).toBe(0);
    });

    it('scans again once a port appears', () => {
        const r = resolver({
            cache: { records: {}, discovered: [{ pid: 300, url: 'http://localhost:8000/' }], ports: [8000] },
            ports: [8000, 8001],
            alivePids: [300],
            processes: [{ pid: 300, ports: [8000], files: [owned] }]
        });
        r.discover();
        expect(r.scans()).toBe(1);
    });

    it('scans again once a known pid is gone', () => {
        const r = resolver({
            cache: { records: {}, discovered: [{ pid: 300, url: 'http://localhost:8000/' }], ports: [8000] },
            ports: [8000],
            alivePids: [],
            processes: []
        });
        expect(r.discover()).toEqual([]);
        expect(r.scans()).toBe(1);
    });

    it('keeps what it knows when netstat cannot answer', () => {
        const r = resolver({
            cache: { records: {}, discovered: [{ pid: 300, url: 'http://localhost:8000/' }], ports: [8000] },
            ports: null,
            processes: null,
            alivePids: [300]
        });
        expect(r.discover()).toEqual(['http://localhost:8000/']);
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

    // The real resolver, with the kernel's answer stood in for: which log is
    // being served on which port.
    function serving(served: Record<string, number>): typeof createServerResolver {
        return (transcript, records) => createServerResolver(transcript, records, {
            readServerCache: () => ({ records: {}, discovered: [], ports: [] }),
            writeServerCache: () => { /* tests leave nothing on disk */ },
            findServerEndpoints: () => new Map(Object.entries(served).map(([log, port]) => [log, { pid: 4242, ports: [port] }])),
            isPidAlive: () => true,
            listeningPorts: () => [],
            findListeningProcesses: () => []
        });
    }

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

        expect(collectDevServerUrls(session, { createServerResolver: serving({ [log]: 8000 }) })).toEqual(['http://localhost:8000/']);
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

        expect(collectDevServerUrls(session, { createServerResolver: serving({ [log]: 8000 }) })).toEqual(['http://localhost:8000/']);
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

        expect(collectDevServerUrls(session, { createServerResolver: serving({}) })).toEqual([]);
    });

    it('hides a reachable URL once the process that logged it is gone', () => {
        const session = path.join(tmpDir, 'sess.jsonl');
        fs.writeFileSync(session, '');
        const sessionDir = path.join(tmpDir, 'sess');
        fs.mkdirSync(sessionDir);
        const log = path.join(tmpDir, 'devserver.log');
        fs.writeFileSync(log, '  ➜  Local:   http://localhost:8001/\n');
        fs.writeFileSync(path.join(sessionDir, 'dev-servers.json'), JSON.stringify({
            servers: [{
                id: 'stopped',
                command: `pnpm dev > ${log} 2>&1`,
                outputFile: log,
                redirect: log,
                ts: 1
            }]
        }));

        // Someone else's dev server now holds 8001, so the port answers while
        // this record's own process is long gone.
        expect(collectDevServerUrls(session, { createServerResolver: serving({ [path.join(tmpDir, 'other.log')]: 8001 }) })).toEqual([]);
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
        fs.writeFileSync(path.join(sessionDir, 'dev-servers.json'), JSON.stringify({ servers: [{ id: 'wt2', command: 'nohup pnpm dev > x.log &', outputFile: log, redirect: log, ts: 1 }] }));

        expect(collectDevServerUrls(session, { createServerResolver: serving({ [log]: 8001 }) })).toEqual(['http://localhost:8001/']);
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

        expect(collectDevServerUrls(session, { createServerResolver: serving({ [a]: 8000, [b]: 8001, [c]: 8002 }) })).toEqual([
            'http://localhost:8002/',
            'http://localhost:8001/'
        ]);
    });
});
