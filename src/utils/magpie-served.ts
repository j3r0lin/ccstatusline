import {
    execFileSync,
    spawn
} from 'child_process';
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync
} from 'fs';
import os from 'node:os';
import path from 'node:path';

// magpie writes the route group it was asked for (e.g. `auto-sonnet`) into each
// reply's `message.model`, so a transcript alone cannot say which model served a
// step. magpie's own log can: its `response_id` equals the transcript's
// `message.id`. This cache holds that mapping, shaped after jira-issue-cache.ts:
// rendering only reads the file, and a detached child of this program refreshes it.

interface ServedEntry {
    model: string;
    /** When magpie logged the step, in epoch ms; drives pruning. */
    at: number;
}

export interface ServedCache {
    version: 1;
    ids: Record<string, ServedEntry>;
    /** Start of the time range the fetches so far cover, in epoch ms. */
    coveredFrom: number;
    /** When the last successful fetch started, in epoch ms. */
    fetchedAt: number;
    /** When the last fetch was attempted, so a failing `magpie` is not retried on every render. */
    attemptedAt: number;
}

export interface ServedRow {
    id: string;
    model: string;
    at: number;
}

export const MAGPIE_SERVED_REFRESH_FLAG = '--internal-refresh-magpie-served';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_FETCH_INTERVAL_MS = 30_000;
/** A reply still being written when a fetch starts may be logged after it, so the newest minute of coverage is not trusted. */
const SETTLE_MS = 60_000;
const WINDOW_MARGIN_MS = 5 * 60_000;
const LOCK_STALE_MS = 60_000;
const CLI_TIMEOUT_MS = 30_000;
const CLI_MAX_BUFFER = 256 * 1024 * 1024;

export interface MagpieServedDeps {
    closeSync: typeof closeSync;
    execFileSync: typeof execFileSync;
    existsSync: typeof existsSync;
    getExecPath: () => string;
    getHomedir: () => string;
    getScriptPath: () => string | undefined;
    mkdirSync: typeof mkdirSync;
    openSync: typeof openSync;
    readFileSync: typeof readFileSync;
    renameSync: typeof renameSync;
    spawn: typeof spawn;
    statSync: typeof statSync;
    unlinkSync: typeof unlinkSync;
    writeFileSync: typeof writeFileSync;
    now: () => number;
}

export const DEFAULT_MAGPIE_SERVED_DEPS: MagpieServedDeps = {
    closeSync,
    execFileSync,
    existsSync,
    getExecPath: () => process.execPath,
    // A function, not `os.homedir` itself, so a test's spy on it is honored
    getHomedir: () => os.homedir(),
    getScriptPath: () => process.argv[1],
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    spawn,
    statSync,
    unlinkSync,
    writeFileSync,
    now: Date.now
};

function getCachePath(deps: MagpieServedDeps): string {
    return path.join(deps.getHomedir(), '.cache', 'ccstatusline', 'magpie-served.json');
}

function getLockPath(deps: MagpieServedDeps): string {
    return `${getCachePath(deps)}.lock`;
}

// A quoted field may hold commas, doubled quotes and newlines (error messages do)
function parseCsvRecords(text: string): string[][] {
    const records: string[][] = [];
    let record: string[] = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const char = text.charAt(i);
        if (quoted) {
            if (char === '"') {
                if (text.charAt(i + 1) === '"') {
                    field += '"';
                    i++;
                } else {
                    quoted = false;
                }
            } else {
                field += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ',') {
            record.push(field);
            field = '';
        } else if (char === '\n' || char === '\r') {
            if (char === '\r' && text.charAt(i + 1) === '\n') {
                i++;
            }
            record.push(field);
            field = '';
            records.push(record);
            record = [];
        } else {
            field += char;
        }
    }
    if (field !== '' || record.length > 0) {
        record.push(field);
        records.push(record);
    }
    return records;
}

export function parseServedCsv(csv: string, fallbackAt: number): ServedRow[] {
    const [header, ...records] = parseCsvRecords(csv);
    if (!header) {
        return [];
    }

    const idColumn = header.indexOf('response_id');
    const modelColumn = header.indexOf('served_model');
    const timeColumn = header.indexOf('time');
    if (idColumn === -1 || modelColumn === -1) {
        return [];
    }

    const rows: ServedRow[] = [];
    for (const record of records) {
        const id = record[idColumn] ?? '';
        const model = record[modelColumn] ?? '';
        if (id === '' || model === '') {
            continue;
        }
        const time = timeColumn === -1 ? NaN : Date.parse(record[timeColumn] ?? '');
        rows.push({ id, model, at: Number.isNaN(time) ? fallbackAt : time });
    }
    return rows;
}

function emptyCache(): ServedCache {
    return { version: 1, ids: {}, coveredFrom: 0, fetchedAt: 0, attemptedAt: 0 };
}

/**
 * Adds a fetch's rows to the cache and widens the covered range with it.
 *
 * @param fetchedAt - When the fetch started
 * @param windowMs - How far back the fetch reached
 * @param now - Entries logged more than 7 days before this are dropped
 */
export function mergeServed(
    previous: ServedCache | null,
    rows: ServedRow[],
    fetchedAt: number,
    windowMs: number,
    now: number
): ServedCache {
    const oldest = now - MAX_AGE_MS;
    const ids: Record<string, ServedEntry> = {};
    for (const [id, entry] of Object.entries(previous?.ids ?? {})) {
        if (entry.at >= oldest) {
            ids[id] = entry;
        }
    }
    for (const row of rows) {
        if (row.at >= oldest) {
            ids[row.id] = { model: row.model, at: row.at };
        }
    }

    const from = fetchedAt - windowMs;
    // A gap would claim time nobody fetched, so a range that does not reach the old one replaces it
    const joins = previous !== null && previous.fetchedAt > 0 && from <= previous.fetchedAt;
    const coveredFrom = Math.max(joins ? Math.min(previous.coveredFrom, from) : from, oldest);
    return { version: 1, ids, coveredFrom, fetchedAt, attemptedAt: fetchedAt };
}

export function readServedCache(deps: MagpieServedDeps = DEFAULT_MAGPIE_SERVED_DEPS): ServedCache | null {
    try {
        const parsed = JSON.parse(deps.readFileSync(getCachePath(deps), 'utf-8')) as Partial<ServedCache>;
        if (
            parsed.version === 1
            && typeof parsed.ids === 'object'
            && typeof parsed.coveredFrom === 'number'
            && typeof parsed.fetchedAt === 'number'
            && typeof parsed.attemptedAt === 'number'
        ) {
            return parsed as ServedCache;
        }
    } catch {
        // No usable cache
    }
    return null;
}

function writeServedCache(cache: ServedCache, deps: MagpieServedDeps): void {
    const cachePath = getCachePath(deps);
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    try {
        deps.mkdirSync(path.dirname(cachePath), { recursive: true });
        deps.writeFileSync(tmpPath, JSON.stringify(cache), 'utf-8');
        deps.renameSync(tmpPath, cachePath);
    } catch {
        try {
            deps.unlinkSync(tmpPath);
        } catch {
            // Nothing more to do for a tmp file that cannot be removed
        }
    }
}

/**
 * How far back (ms) a fetch must reach to resolve the given unresolved steps, or null when none is due.
 *
 * @remarks
 * A step is worth a fetch only when its time lies outside what earlier fetches covered:
 * inside that range magpie has no record of it (the call did not go through magpie),
 * and asking again would not change that.
 *
 * @param unresolvedAts - Times, in epoch ms, of steps that have no served model
 */
export function servedRefreshWindow(cache: ServedCache | null, unresolvedAts: number[], now: number): number | null {
    const due = unresolvedAts.filter(at => at >= now - MAX_AGE_MS
        && (cache === null || at < cache.coveredFrom || at > cache.fetchedAt - SETTLE_MS)
    );
    if (due.length === 0) {
        return null;
    }
    if (cache !== null && now - Math.max(cache.fetchedAt, cache.attemptedAt) <= MIN_FETCH_INTERVAL_MS) {
        return null;
    }
    return Math.min(now - Math.min(...due) + WINDOW_MARGIN_MS, MAX_AGE_MS);
}

function createLock(deps: MagpieServedDeps): string | null {
    const lockPath = getLockPath(deps);
    try {
        deps.mkdirSync(path.dirname(lockPath), { recursive: true });
    } catch {
        return null;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            deps.closeSync(deps.openSync(lockPath, 'wx'));
            return lockPath;
        } catch {
            try {
                if (deps.now() - deps.statSync(lockPath).mtimeMs <= LOCK_STALE_MS) {
                    return null;
                }
                deps.unlinkSync(lockPath);
            } catch {
                return null;
            }
        }
    }
    return null;
}

function releaseLock(lockPath: string, deps: MagpieServedDeps): void {
    try {
        deps.unlinkSync(lockPath);
    } catch {
        // Another process may already have cleaned up a stale lock
    }
}

/** Starts a detached refresh when the unresolved steps call for one; never blocks the render. */
export function requestServedRefresh(
    cache: ServedCache | null,
    unresolvedAts: number[],
    deps: MagpieServedDeps = DEFAULT_MAGPIE_SERVED_DEPS
): void {
    const windowMs = servedRefreshWindow(cache, unresolvedAts, deps.now());
    const scriptPath = deps.getScriptPath();
    if (windowMs === null || !scriptPath) {
        return;
    }

    const lockPath = createLock(deps);
    if (!lockPath) {
        return;
    }

    try {
        const child = deps.spawn(
            deps.getExecPath(),
            [scriptPath, MAGPIE_SERVED_REFRESH_FLAG, String(Math.ceil(windowMs)), lockPath],
            { detached: true, stdio: 'ignore', windowsHide: true }
        );
        child.unref();
    } catch {
        releaseLock(lockPath, deps);
    }
}

/** Body of the detached child: fetches magpie's log for the window and merges it into the cache. */
export function refreshServedCacheFromCli(
    windowMs: number,
    lockPath: string,
    deps: MagpieServedDeps = DEFAULT_MAGPIE_SERVED_DEPS
): void {
    try {
        if (!Number.isFinite(windowMs) || windowMs <= 0) {
            return;
        }
        const window = Math.min(windowMs, MAX_AGE_MS);
        const startedAt = deps.now();
        const previous = readServedCache(deps);
        try {
            const csv = deps.execFileSync(
                'magpie',
                ['usage', '--csv', '--last', `${Math.ceil(window / 60_000)}m`],
                {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                    timeout: CLI_TIMEOUT_MS,
                    maxBuffer: CLI_MAX_BUFFER,
                    windowsHide: true
                }
            );
            writeServedCache(mergeServed(previous, parseServedCsv(csv, startedAt), startedAt, window, deps.now()), deps);
        } catch {
            // magpie missing or failing: record the attempt so renders do not retry at once
            writeServedCache({ ...(previous ?? emptyCache()), attemptedAt: startedAt }, deps);
        }
    } finally {
        // Only unlink the path derived here, so the internal flag cannot become an arbitrary file delete
        if (lockPath === getLockPath(deps)) {
            releaseLock(lockPath, deps);
        }
    }
}
