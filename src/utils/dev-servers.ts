import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { stripSgrCodes } from './ansi';

export interface DevServerRecord {
    id: string;
    command: string;
    outputFile: string;
    redirect?: string;
    ts: number;
}

export interface DevServersSidecar { servers: DevServerRecord[] }

const MAX_URLS = 2;
const LOCAL_LINE = /^\s*(?:➜|->)?\s*Local:\s+(https?:\/\/\S+)/im;
const LOOPBACK = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i;
const ANY_LOOPBACK = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?=\/?(?:[\s)\]'"]|$))/gi;
const TAIL_BYTES = 32 * 1024;

export function sidecarPathFromTranscript(transcriptPath: string): string {
    const resolved = path.resolve(transcriptPath);
    const dir = path.dirname(resolved);
    if (path.basename(dir) === 'subagents')
        return path.join(path.dirname(dir), 'dev-servers.json');
    const stem = path.basename(resolved, path.extname(resolved));
    return path.join(dir, stem, 'dev-servers.json');
}

export function extraSidecarPaths(transcriptPath: string): string[] {
    const primary = sidecarPathFromTranscript(transcriptPath);
    const sessionDir = path.dirname(primary);
    const extra: string[] = [];
    const subagents = path.join(sessionDir, 'subagents');
    if (!fs.existsSync(subagents))
        return extra;
    let names: string[];
    try {
        names = fs.readdirSync(subagents);
    } catch {
        return extra;
    }
    for (const name of names) {
        if (!name.endsWith('.jsonl'))
            continue;
        const candidate = path.join(subagents, path.basename(name, '.jsonl'), 'dev-servers.json');
        if (candidate !== primary)
            extra.push(candidate);
    }
    return extra;
}

export function readSidecar(filePath: string): DevServerRecord[] {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw) as DevServersSidecar;
        if (!Array.isArray(parsed.servers))
            return [];
        return parsed.servers.filter(isRecord);
    } catch {
        return [];
    }
}

function isRecord(value: unknown): value is DevServerRecord {
    if (!value || typeof value !== 'object')
        return false;
    const rec = value as DevServerRecord;
    return typeof rec.id === 'string'
        && typeof rec.outputFile === 'string'
        && rec.outputFile.length > 0;
}

export function logPathsFor(record: DevServerRecord): string[] {
    const paths: string[] = [];
    if (record.redirect && record.redirect.length > 0)
        paths.push(record.redirect);
    if (record.outputFile && record.outputFile !== record.redirect)
        paths.push(record.outputFile);
    return paths;
}

export function extractDevServerUrl(rawText: string): string | null {
    const text = stripSgrCodes(rawText);
    const local = LOCAL_LINE.exec(text);
    if (local?.[1])
        return normalizeUrl(local[1]);

    const matches = text.match(ANY_LOOPBACK) ?? [];
    for (const raw of matches) {
        const url = normalizeUrl(raw);
        const origin = url.replace(/\/+$/, '');
        if (LOOPBACK.test(origin) || LOOPBACK.test(`${origin}/`))
            return `${origin}/`;
    }
    return null;
}

export function normalizeUrl(raw: string): string {
    const trimmed = raw.replace(/[.,;:)]+$/, '');
    if (trimmed.endsWith('/'))
        return trimmed;
    return `${trimmed}/`;
}

function readSlice(filePath: string, start: number, length: number): string {
    if (length <= 0)
        return '';
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(length);
        const n = fs.readSync(fd, buf, 0, length, start);
        return buf.subarray(0, n).toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

export function headFile(filePath: string, maxBytes = TAIL_BYTES): string {
    try {
        const size = fs.statSync(filePath).size;
        return readSlice(filePath, 0, Math.min(size, maxBytes));
    } catch {
        return '';
    }
}

export function tailFile(filePath: string, maxBytes = TAIL_BYTES): string {
    try {
        const size = fs.statSync(filePath).size;
        const start = size > maxBytes ? size - maxBytes : 0;
        return readSlice(filePath, start, size - start);
    } catch {
        return '';
    }
}

// Dev servers print `Local:` once at startup, so it lives at the head of the
// log; the tail of a long-running vite log is only HMR noise and stack frames.
export function readDevServerLog(filePath: string, deps: { headFile?: typeof headFile; tailFile?: typeof tailFile } = {}): string | null {
    const head = (deps.headFile ?? headFile)(filePath);
    const fromHead = extractDevServerUrl(head);
    if (fromHead)
        return fromHead;
    return extractDevServerUrl((deps.tailFile ?? tailFile)(filePath));
}

// The logs a record can be recognised by. Both of them qualify: the redirect is
// the user's own `> log`, and the CC output file is where the harness wires the
// process's stdout when the command carries no redirect of its own — a plain
// `pnpm dev` run in the background gets only the latter. Either way the
// server's own processes hold the fd for as long as they live.
//
// /dev/null is the exception, held open by half the machine.
export function anchorLogs(record: DevServerRecord): string[] {
    return logPathsFor(record).filter(p => !p.startsWith('/dev/'));
}

// A loopback listening address as lsof prints it. `*` and `[::]` are the
// wildcard binds a dev server started with --host gets, and localhost still
// reaches those.
const LISTEN_ADDRESS = /^(?:\*|127\.0\.0\.1|\[::1\]|\[::\]):(\d+)$/;

export interface ServerEndpoint {
    pid: number;
    ports: number[];
}

// One lsof answers the whole question: which process holds a record's log open,
// and what that process is listening on.
//
// The log is the only thing tying a process to a record — a detached
// `( cmd > log 2>&1 & )` leaves no shell to recognise by its command line, but
// whoever writes the log keeps its fd. And a listening socket is itself the
// proof the server is up, so the port comes from the kernel instead of from
// parsing the log, and nothing needs to probe it.
//
// `null` means lsof could not answer and no record should be judged by it.
export function findServerEndpoints(logs: string[]): Map<string, ServerEndpoint> | null {
    if (logs.length === 0)
        return new Map();
    // lsof exits 1 as soon as one of the logs has no open fd, so its own output
    // is still the answer; runLsof only gives up when lsof itself is missing.
    const out = runLsof(['-nP', '-w', '-Fpn', '-iTCP', '-sTCP:LISTEN', '--', ...logs]);
    return out === null ? null : parseEndpoints(out, logs);
}

export function parseEndpoints(lsofOutput: string, logs: string[]): Map<string, ServerEndpoint> {
    const wanted = new Set(logs);
    const endpoints = new Map<string, ServerEndpoint>();
    for (const proc of processesInLsofOutput(lsofOutput)) {
        const ports: number[] = [];
        const logsHeld: string[] = [];
        for (const name of proc.names) {
            const listening = LISTEN_ADDRESS.exec(name);
            if (listening?.[1])
                ports.push(Number.parseInt(listening[1], 10));
            else if (wanted.has(name))
                logsHeld.push(name);
        }
        // A pnpm wrapper holds the log without listening; vite does both. Only
        // the process that does both says where to point the link.
        if (ports.length === 0)
            continue;
        for (const log of logsHeld) {
            if (!endpoints.has(log))
                endpoints.set(log, { pid: proc.pid, ports });
        }
    }
    return endpoints;
}

// Every loopback port something is listening on. netstat gives no pids, but it
// costs a twentieth of lsof, which makes it the cheap way to tell whether
// anything has changed since the last render.
export function listeningPorts(): number[] | null {
    let out: string;
    try {
        out = execFileSync('netstat', ['-an', '-p', 'tcp'], {
            timeout: 2000,
            encoding: 'utf8',
            maxBuffer: 8 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore']
        });
    } catch {
        return null;
    }
    return parseListeningPorts(out);
}

// macOS netstat writes an address as `127.0.0.1.8000`, port last.
const NETSTAT_LOCAL = /^(?:127\.0\.0\.1|\*|::1|::)\.(\d+)$/;

export function parseListeningPorts(netstatOutput: string): number[] {
    const ports = new Set<number>();
    for (const line of netstatOutput.split('\n')) {
        if (!line.includes('LISTEN'))
            continue;
        const local = line.trim().split(/\s+/)[3];
        const match = local ? NETSTAT_LOCAL.exec(local) : null;
        if (match?.[1])
            ports.add(Number.parseInt(match[1], 10));
    }
    return [...ports].sort((a, b) => a - b);
}

export interface ListeningProcess {
    pid: number;
    ports: number[];
    files: string[];
}

// Every process listening on a loopback port, with the files it holds open.
// Two lsof calls: the first is cheap and narrows the field to a handful of
// pids, the second asks only about those.
export function findListeningProcesses(): ListeningProcess[] | null {
    const listen = runLsof(['-nP', '-w', '-Fpn', '-iTCP', '-sTCP:LISTEN']);
    if (listen === null)
        return null;

    const ports = new Map<number, number[]>();
    for (const proc of processesInLsofOutput(listen)) {
        for (const name of proc.names) {
            const match = LISTEN_ADDRESS.exec(name);
            if (!match?.[1])
                continue;
            const held = ports.get(proc.pid) ?? [];
            held.push(Number.parseInt(match[1], 10));
            ports.set(proc.pid, held);
        }
    }
    if (ports.size === 0)
        return [];

    const fds = runLsof(['-nP', '-w', '-Fpn', '-p', [...ports.keys()].join(',')]);
    if (fds === null)
        return null;

    const found: ListeningProcess[] = [];
    for (const proc of processesInLsofOutput(fds)) {
        const listeningOn = ports.get(proc.pid);
        if (!listeningOn)
            continue;
        found.push({
            pid: proc.pid,
            ports: listeningOn,
            files: proc.names.filter(n => !LISTEN_ADDRESS.test(n) && n.startsWith('/'))
        });
    }
    return found;
}

function runLsof(args: string[]): string | null {
    try {
        return execFileSync('lsof', args, {
            timeout: 5000,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore']
        });
    } catch (err) {
        const captured = (err as { stdout?: string }).stdout;
        return typeof captured === 'string' ? captured : null;
    }
}

// Which of the files a process holds open belong to this session. Claude Code
// names a background job's directory after the first segment of the session id,
// and writes a task's captured output under a path carrying the whole id.
export function sessionOwnedFiles(files: string[], sessionId: string): string[] {
    const jobDir = `/jobs/${sessionId.split('-')[0] ?? sessionId}/`;
    return files.filter(f => f.includes(sessionId) || f.includes(jobDir));
}

// The port the log announces, but only when the process really has it open.
//
// Sitting in the session's directory is not enough to be its dev server: a
// browser or a language server started by the same session is parked there too,
// listening on some ephemeral port. A dev server prints its own address, and a
// record vouched for by the sidecar needs no such proof — this is what stands in
// for that vouching when discovery finds a server on its own.
export function announcedPort(declared: string | null, openPorts: number[]): number | null {
    if (declared === null)
        return null;
    try {
        const stated = Number.parseInt(new URL(declared).port, 10);
        return openPorts.includes(stated) ? stated : null;
    } catch {
        return null;
    }
}

export function sessionIdFromTranscript(transcriptPath: string): string {
    const resolved = path.resolve(transcriptPath);
    const dir = path.dirname(resolved);
    const stem = path.basename(resolved, path.extname(resolved));
    // A subagent transcript sits in <session>/subagents/, so the session id is
    // the directory above it.
    return path.basename(dir) === 'subagents' ? path.basename(path.dirname(dir)) : stem;
}

function processesInLsofOutput(out: string): { pid: number; names: string[] }[] {
    const procs: { pid: number; names: string[] }[] = [];
    let current: { pid: number; names: string[] } | null = null;
    for (const line of out.split('\n')) {
        if (line.startsWith('p')) {
            const pid = Number.parseInt(line.slice(1), 10);
            current = Number.isInteger(pid) ? { pid, names: [] } : null;
            if (current)
                procs.push(current);
        } else if (line.startsWith('n') && current) {
            current.names.push(line.slice(1));
        }
    }
    return procs;
}

// The log says which scheme and host name to show; the kernel says which port
// is really open. When the log names one of the open ports, that is the one the
// server meant.
export function endpointUrl(declared: string | null, ports: number[]): string | null {
    const port = pickPort(declared, ports);
    if (port === null)
        return null;
    if (declared) {
        try {
            const url = new URL(declared);
            url.port = String(port);
            return normalizeUrl(url.toString());
        } catch { /* fall through to a plain loopback URL */ }
    }
    return `http://localhost:${port}/`;
}

function pickPort(declared: string | null, ports: number[]): number | null {
    if (ports.length === 0)
        return null;
    if (declared) {
        try {
            const stated = Number.parseInt(new URL(declared).port, 10);
            if (ports.includes(stated))
                return stated;
        } catch { /* the log's URL is unusable, any open port beats none */ }
    }
    return ports[0] ?? null;
}

export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM is a live process this user does not own.
        return (err as { code?: string }).code === 'EPERM';
    }
}

function realPath(filePath: string): string {
    try {
        return fs.realpathSync(filePath);
    } catch {
        return filePath;
    }
}

function mtimeOf(filePath: string): number {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return -1;
    }
}

export interface ResolvedServer {
    // null once a lookup found nothing: no listening process holds the logs.
    pid: number | null;
    url: string | null;
    // One per anchor log, in order, so a rewritten log invalidates the answer.
    mtimes: number[];
}

export interface DiscoveredServer {
    pid: number;
    url: string;
}

export interface ServerCache {
    // Keyed by sidecar record id: a record has more than one log to recognise it.
    records: Record<string, ResolvedServer>;
    // Servers found by asking the kernel, which the sidecar never recorded.
    discovered: DiscoveredServer[];
    // The loopback ports seen last time. While this set holds and every pid
    // above is alive, nothing has started or stopped and no scan is needed.
    ports: number[];
}

export function serverCachePath(transcriptPath: string): string {
    const sessionDir = path.dirname(sidecarPathFromTranscript(transcriptPath));
    return path.join(sessionDir, 'dev-servers-resolved.json');
}

export function readServerCache(filePath: string): ServerCache {
    const cache: ServerCache = {
        records: {},
        discovered: [],
        ports: []
    };
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return cache; // no cache yet, or someone else is mid-write
    }
    if (!parsed || typeof parsed !== 'object')
        return cache;
    const raw = parsed as { records?: unknown; discovered?: unknown; ports?: unknown };

    if (raw.records && typeof raw.records === 'object') {
        for (const [id, value] of Object.entries(raw.records as Record<string, unknown>)) {
            if (!value || typeof value !== 'object')
                continue;
            const entry = value as Partial<ResolvedServer>;
            const pid = entry.pid ?? null;
            const url = entry.url ?? null;
            if ((pid === null || typeof pid === 'number') && (url === null || typeof url === 'string')
                && Array.isArray(entry.mtimes) && entry.mtimes.every(m => typeof m === 'number'))
                cache.records[id] = { pid, url, mtimes: entry.mtimes };
        }
    }
    if (Array.isArray(raw.discovered)) {
        for (const value of raw.discovered) {
            if (!value || typeof value !== 'object')
                continue;
            const entry = value as Partial<DiscoveredServer>;
            if (typeof entry.pid === 'number' && typeof entry.url === 'string')
                cache.discovered.push({ pid: entry.pid, url: entry.url });
        }
    }
    if (Array.isArray(raw.ports))
        cache.ports = raw.ports.filter((p): p is number => typeof p === 'number');
    return cache;
}

export function writeServerCache(filePath: string, cache: ServerCache): void {
    // Several status lines can render at once, so the cache lands by rename and
    // a reader never sees half a file.
    const tmp = `${filePath}.${process.pid}.tmp`;
    try {
        // A session that never had a dev server recorded has no directory here.
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(cache));
        fs.renameSync(tmp, filePath);
    } catch {
        try {
            fs.unlinkSync(tmp);
        } catch { /* never got created */ }
    }
}

// Resolves each record to the URL it is serving right now, or to null when it
// is not serving anything.
//
// Asking the kernel costs one lsof over every process on the machine, so the
// answer is cached against the pid behind it and re-checked with a signal-0
// kill, which is free. A record whose process is gone and whose log nobody has
// written to since stays resolved as gone, without asking lsof again.
export function createServerResolver(
    transcriptPath: string,
    records: DevServerRecord[],
    deps: {
        readServerCache?: typeof readServerCache;
        writeServerCache?: typeof writeServerCache;
        findServerEndpoints?: typeof findServerEndpoints;
        isPidAlive?: typeof isPidAlive;
        readDevServerLog?: typeof readDevServerLog;
        listeningPorts?: typeof listeningPorts;
        findListeningProcesses?: typeof findListeningProcesses;
    } = {}
) {
    const readCache = deps.readServerCache ?? readServerCache;
    const writeCache = deps.writeServerCache ?? writeServerCache;
    const findEndpoints = deps.findServerEndpoints ?? findServerEndpoints;
    const alive = deps.isPidAlive ?? isPidAlive;
    const readLog = deps.readDevServerLog ?? readDevServerLog;
    const ports_ = deps.listeningPorts ?? listeningPorts;
    const findListening = deps.findListeningProcesses ?? findListeningProcesses;

    let discovered: DiscoveredServer[] | undefined;
    let seenPorts: number[] | undefined;

    const cachePath = serverCachePath(transcriptPath);
    const cache = readCache(cachePath);
    const fresh: Record<string, ResolvedServer> = {};
    let endpoints: Map<string, ServerEndpoint> | null | undefined;
    let changed = false;

    function urlFor(record: DevServerRecord): string | null {
        const anchors = anchorLogs(record);
        // Nothing to recognise this record by, so take the log at its word
        // rather than dropping a server that may well be up.
        if (anchors.length === 0)
            return declaredUrl(record);

        const cached = cache.records[record.id];
        if (cached) {
            if (cached.pid !== null && alive(cached.pid))
                return cached.url;
            if (unchangedSince(cached.mtimes, anchors))
                return null;
        }

        if (endpoints === undefined)
            endpoints = findEndpoints(records.flatMap(anchorLogs));
        if (endpoints === null)
            return declaredUrl(record);

        const endpoint = endpointFor(anchors, endpoints);
        const url = endpoint ? endpointUrl(declaredUrl(record), endpoint.ports) : null;
        fresh[record.id] = { pid: endpoint?.pid ?? null, url, mtimes: anchors.map(mtimeOf) };
        changed = true;
        return url;
    }

    function endpointFor(anchors: string[], found: Map<string, ServerEndpoint>): ServerEndpoint | undefined {
        for (const log of anchors) {
            const endpoint = found.get(log) ?? found.get(realPath(log));
            if (endpoint)
                return endpoint;
        }
        return undefined;
    }

    function unchangedSince(mtimes: number[], anchors: string[]): boolean {
        return mtimes.length === anchors.length && anchors.every((log, i) => mtimes[i] === mtimeOf(log));
    }

    function declaredUrl(record: DevServerRecord): string | null {
        for (const log of logPathsFor(record)) {
            const url = readLog(log);
            if (url)
                return url;
        }
        return null;
    }

    // Servers the sidecar never recorded. The cheap netstat call decides whether
    // the expensive scan is needed at all: if the same ports are open and every
    // pid found last time is still alive, nothing has started or stopped.
    function discover(): string[] {
        const known = cache.discovered.filter(s => alive(s.pid));
        const ports = ports_();
        // No port has appeared that was not open last time, and every server
        // found then is still running: nothing can have started. A port going
        // away needs no scan — the pid check above already caught that.
        if (ports !== null && known.length === cache.discovered.length && noNewPorts(ports, cache.ports))
            return known.map(s => s.url);

        const processes = findListening();
        if (processes === null)
            return known.map(s => s.url);

        const sessionId = sessionIdFromTranscript(transcriptPath);
        const found: DiscoveredServer[] = [];
        for (const proc of processes) {
            for (const owned of sessionOwnedFiles(proc.files, sessionId)) {
                const declared = readLog(owned);
                const port = announcedPort(declared, proc.ports);
                if (port === null)
                    continue;
                const url = endpointUrl(declared, [port]);
                if (url) {
                    found.push({ pid: proc.pid, url });
                    break;
                }
            }
        }
        discovered = found;
        seenPorts = ports ?? [];
        changed = true;
        return found.map(s => s.url);
    }

    function flush(): void {
        if (!changed)
            return;
        const merged: ServerCache = {
            records: {},
            discovered: discovered ?? cache.discovered,
            ports: seenPorts ?? cache.ports
        };
        for (const record of records) {
            const entry = fresh[record.id] ?? cache.records[record.id];
            if (entry)
                merged.records[record.id] = entry;
        }
        writeCache(cachePath, merged);
    }

    return {
        urlFor,
        discover,
        flush
    };
}

function noNewPorts(current: number[], previous: number[]): boolean {
    const before = new Set(previous);
    return current.every(p => before.has(p));
}

export function collectDevServerUrls(
    transcriptPath: string,
    deps: {
        readSidecar?: typeof readSidecar;
        extraSidecarPaths?: typeof extraSidecarPaths;
        createServerResolver?: typeof createServerResolver;
    } = {}
): string[] {
    const read = deps.readSidecar ?? readSidecar;
    const extras = deps.extraSidecarPaths ?? extraSidecarPaths;
    const createResolver = deps.createServerResolver ?? createServerResolver;

    const files = [sidecarPathFromTranscript(transcriptPath), ...extras(transcriptPath)];
    const records: DevServerRecord[] = [];
    const seenIds = new Set<string>();
    for (const file of files) {
        for (const rec of read(file)) {
            if (seenIds.has(rec.id))
                continue;
            seenIds.add(rec.id);
            records.push(rec);
        }
    }
    records.sort((a, b) => a.ts - b.ts);

    const urls: string[] = [];
    const seenUrl = new Set<string>();
    const resolver = createResolver(transcriptPath, records);
    const add = (url: string | null): boolean => {
        if (!url || seenUrl.has(url))
            return false;
        seenUrl.add(url);
        urls.push(url);
        return urls.length >= MAX_URLS;
    };

    for (let i = records.length - 1; i >= 0 && urls.length < MAX_URLS; i--) {
        const rec = records[i];
        if (rec)
            add(resolver.urlFor(rec));
    }
    // The sidecar misses servers started without a redirect of their own, so
    // whatever it did not account for gets found by asking the kernel.
    if (urls.length < MAX_URLS) {
        for (const url of resolver.discover()) {
            if (add(url))
                break;
        }
    }
    resolver.flush();
    return urls;
}
