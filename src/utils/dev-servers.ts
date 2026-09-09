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

export interface DevServersSidecar {
    servers: DevServerRecord[];
}

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
    let names: string[] = [];
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
        if (!parsed || !Array.isArray(parsed.servers))
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

export function isUrlReachable(url: string, probe: (host: string, port: string) => boolean = defaultTcpProbe): boolean {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^\[|\]$/g, '');
        const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
        return probe(host, port);
    } catch {
        return false;
    }
}

function defaultTcpProbe(host: string, port: string): boolean {
    try {
        execFileSync('nc', ['-z', '-w', '1', host, port], {
            timeout: 500,
            stdio: 'ignore'
        });
        return true;
    } catch {
        return false;
    }
}

export function collectDevServerUrls(
    transcriptPath: string,
    deps: {
        readSidecar?: typeof readSidecar;
        tailFile?: typeof tailFile;
        isUrlReachable?: typeof isUrlReachable;
        extraSidecarPaths?: typeof extraSidecarPaths;
    } = {}
): string[] {
    const read = deps.readSidecar ?? readSidecar;
    const tail = deps.tailFile ?? tailFile;
    const reachable = deps.isUrlReachable ?? isUrlReachable;
    const extras = deps.extraSidecarPaths ?? extraSidecarPaths;

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
    records.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

    const urls: string[] = [];
    const seenUrl = new Set<string>();
    for (let i = records.length - 1; i >= 0; i--) {
        const rec = records[i];
        const logs = logPathsFor(rec);
        if (logs.length === 0)
            continue;
        let url: string | null = null;
        for (const log of logs) {
            url = readDevServerLog(log, { tailFile: tail });
            if (url)
                break;
        }
        if (!url || !reachable(url) || seenUrl.has(url))
            continue;
        seenUrl.add(url);
        urls.push(url);
        if (urls.length >= MAX_URLS)
            break;
    }
    return urls;
}
