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
    statSync,
    unlinkSync,
    writeFileSync
} from 'fs';
import os from 'node:os';
import path from 'node:path';

// Shaped after git-review-cache.ts: disk-cached, TTL'd, refreshed by a
// detached child process so rendering never blocks on the network/CLI. The
// one structural difference is sharding: this cache keys by issue key, not
// by sha256(cwd + ref), because the same issue's status is identical across
// every worktree that happens to be working on it - one lookup, shared.
export interface JiraIssueStatus {
    key: string;
    statusName: string;
    // Jira's own bucket for the status ('new' | 'indeterminate' | 'done', ...).
    // Used only as a fallback when statusName has no explicit color mapping.
    statusCategoryKey: string;
}

interface StoredJiraIssueCache {
    version: 1;
    data: JiraIssueStatus | null;
}

interface CachedJiraIssueStatus {
    data: JiraIssueStatus | null;
    stale: boolean;
}

const JIRA_ISSUE_CACHE_TTL = 60_000;
const CLI_TIMEOUT = 5_000;
const REFRESH_LOCK_STALE_MS = 30_000;
export const JIRA_ISSUE_REFRESH_FLAG = '--internal-refresh-jira-issue-cache';

export interface JiraIssueCacheDeps {
    closeSync: typeof closeSync;
    execFileSync: typeof execFileSync;
    existsSync: typeof existsSync;
    getExecPath: () => string;
    mkdirSync: typeof mkdirSync;
    openSync: typeof openSync;
    readFileSync: typeof readFileSync;
    getScriptPath: () => string | undefined;
    spawn: typeof spawn;
    statSync: typeof statSync;
    unlinkSync: typeof unlinkSync;
    writeFileSync: typeof writeFileSync;
    getHomedir: typeof os.homedir;
    now: typeof Date.now;
}

const DEFAULT_JIRA_ISSUE_CACHE_DEPS: JiraIssueCacheDeps = {
    closeSync,
    execFileSync,
    existsSync,
    getExecPath: () => process.execPath,
    mkdirSync,
    openSync,
    readFileSync,
    getScriptPath: () => process.argv[1],
    spawn,
    statSync,
    unlinkSync,
    writeFileSync,
    getHomedir: os.homedir,
    now: Date.now
};

function getCacheDir(deps: JiraIssueCacheDeps): string {
    return path.join(deps.getHomedir(), '.cache', 'ccstatusline');
}

function getJiraIssueCacheDir(deps: JiraIssueCacheDeps): string {
    return path.join(getCacheDir(deps), 'jira-issue');
}

// Issue keys are already filesystem-safe (uppercase letters, digits, one
// dash), but encode anyway rather than trust that invariant to hold forever.
function getCachePath(key: string, deps: JiraIssueCacheDeps): string {
    return path.join(getJiraIssueCacheDir(deps), `jira-issue-${encodeURIComponent(key)}.json`);
}

function isJiraIssueStatus(value: unknown): value is JiraIssueStatus {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Partial<JiraIssueStatus>;
    return typeof candidate.key === 'string' && typeof candidate.statusName === 'string';
}

function decodeCache(content: string): JiraIssueStatus | null | 'miss' {
    if (content.length === 0) {
        return null;
    }

    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
        const stored = parsed as Partial<StoredJiraIssueCache>;
        if (stored.version === 1 && (stored.data === null || isJiraIssueStatus(stored.data))) {
            return stored.data;
        }
    }

    return 'miss';
}

function readCache(cachePath: string, deps: JiraIssueCacheDeps): CachedJiraIssueStatus | 'miss' {
    try {
        if (!deps.existsSync(cachePath)) {
            return 'miss';
        }
        const age = deps.now() - deps.statSync(cachePath).mtimeMs;
        const content = deps.readFileSync(cachePath, 'utf-8').trim();
        const decoded = decodeCache(content);
        if (decoded === 'miss') {
            return 'miss';
        }
        return { data: decoded, stale: age > JIRA_ISSUE_CACHE_TTL };
    } catch {
        return 'miss';
    }
}

function writeCache(cachePath: string, data: JiraIssueStatus | null, deps: JiraIssueCacheDeps): void {
    try {
        const cacheDir = getJiraIssueCacheDir(deps);
        if (!deps.existsSync(cacheDir)) {
            deps.mkdirSync(cacheDir, { recursive: true });
        }
        const stored: StoredJiraIssueCache = { version: 1, data };
        deps.writeFileSync(cachePath, JSON.stringify(stored), 'utf-8');
    } catch {
        // Best-effort caching.
    }
}

function fetchFromCli(key: string, deps: JiraIssueCacheDeps): JiraIssueStatus | null {
    const output = deps.execFileSync(
        'jira',
        ['issue', 'view', key, '--raw'],
        {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
            timeout: CLI_TIMEOUT,
            windowsHide: true
        }
    ).trim();

    if (output.length === 0) {
        return null;
    }

    const parsed = JSON.parse(output) as { fields?: { status?: { name?: unknown; statusCategory?: { key?: unknown } } } };
    const statusName = parsed.fields?.status?.name;
    if (typeof statusName !== 'string') {
        return null;
    }
    const statusCategoryKey = parsed.fields?.status?.statusCategory?.key;

    return {
        key,
        statusName,
        statusCategoryKey: typeof statusCategoryKey === 'string' ? statusCategoryKey : ''
    };
}

// Synchronous fetch-or-cached-value used by the detached refresh process.
// jira CLI missing or unauthenticated fails fetchFromCli, which is caught
// here and degrades to stale data (or null) rather than throwing - the
// widget still shows the bare key and link, just without a status color.
export function fetchJiraIssueStatus(
    key: string,
    deps: JiraIssueCacheDeps = DEFAULT_JIRA_ISSUE_CACHE_DEPS
): JiraIssueStatus | null {
    const cachePath = getCachePath(key, deps);
    const cached = readCache(cachePath, deps);
    if (cached !== 'miss' && !cached.stale) {
        return cached.data;
    }

    try {
        const data = fetchFromCli(key, deps);
        writeCache(cachePath, data, deps);
        return data;
    } catch {
        if (cached !== 'miss' && cached.data !== null) {
            return cached.data;
        }
        writeCache(cachePath, null, deps);
        return null;
    }
}

function getRefreshLockPath(cachePath: string): string {
    return `${cachePath}.lock`;
}

function releaseRefreshLock(lockPath: string, deps: JiraIssueCacheDeps): void {
    try {
        deps.unlinkSync(lockPath);
    } catch {
        // Another process may already have cleaned up a stale lock.
    }
}

function createRefreshLock(cachePath: string, deps: JiraIssueCacheDeps): string | null {
    const cacheDir = getJiraIssueCacheDir(deps);
    try {
        if (!deps.existsSync(cacheDir)) {
            deps.mkdirSync(cacheDir, { recursive: true });
        }
    } catch {
        return null;
    }

    const lockPath = getRefreshLockPath(cachePath);
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const descriptor = deps.openSync(lockPath, 'wx');
            deps.closeSync(descriptor);
            return lockPath;
        } catch {
            try {
                const age = deps.now() - deps.statSync(lockPath).mtimeMs;
                if (age <= REFRESH_LOCK_STALE_MS) {
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

function scheduleRefresh(key: string, cachePath: string, deps: JiraIssueCacheDeps): void {
    const scriptPath = deps.getScriptPath();
    if (!scriptPath) {
        return;
    }

    const lockPath = createRefreshLock(cachePath, deps);
    if (!lockPath) {
        return;
    }

    try {
        const child = deps.spawn(
            deps.getExecPath(),
            [scriptPath, JIRA_ISSUE_REFRESH_FLAG, key, lockPath],
            {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            }
        );
        child.unref();
    } catch {
        releaseRefreshLock(lockPath, deps);
    }
}

export function getCachedJiraIssueStatus(
    key: string,
    deps: JiraIssueCacheDeps = DEFAULT_JIRA_ISSUE_CACHE_DEPS
): JiraIssueStatus | null {
    const cachePath = getCachePath(key, deps);
    const cached = readCache(cachePath, deps);

    if (cached === 'miss' || cached.stale) {
        scheduleRefresh(key, cachePath, deps);
    }

    return cached === 'miss' ? null : cached.data;
}

// Optimistic status write for when the session transcript shows a
// `jira issue move KEY "Status"` the cache hasn't caught up with yet. The
// category stays blank: the name-based color map covers the standard
// statuses, and the normal TTL refresh backfills the authoritative record.
// No forced refresh here on purpose - the render can fire while the move is
// still in flight, and a fetch that wins that race would overwrite the new
// status with the old one.
export function applyJiraIssueMoveToCache(
    key: string,
    statusName: string,
    deps: JiraIssueCacheDeps = DEFAULT_JIRA_ISSUE_CACHE_DEPS
): JiraIssueStatus {
    const cachePath = getCachePath(key, deps);
    const cached = readCache(cachePath, deps);
    if (cached !== 'miss' && cached.data !== null && cached.data.statusName === statusName) {
        return cached.data;
    }

    const optimistic: JiraIssueStatus = { key, statusName, statusCategoryKey: '' };
    writeCache(cachePath, optimistic, deps);
    return optimistic;
}

export function refreshJiraIssueCacheFromCli(
    key: string,
    lockPath: string,
    deps: JiraIssueCacheDeps = DEFAULT_JIRA_ISSUE_CACHE_DEPS
): void {
    const expectedLockPath = getRefreshLockPath(getCachePath(key, deps));
    try {
        fetchJiraIssueStatus(key, deps);
    } finally {
        // Only unlink the path derived from the supplied key, so the internal
        // CLI mode can't be abused into an arbitrary file delete.
        if (lockPath === expectedLockPath) {
            releaseRefreshLock(lockPath, deps);
        }
    }
}
