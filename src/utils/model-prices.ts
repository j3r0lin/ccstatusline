import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import {
    closeSync,
    linkSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
    writeSync
} from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import bundledJson from '../data/model-prices.json';
import type { ModelPrices } from '../types/ModelPrice';

import {
    MODELS_DEV_URL,
    extractModelPrices,
    type ModelsDev
} from './model-price-extract';

const bundledPrices: ModelPrices = bundledJson;

// Prices ship in the binary but go stale; a detached child re-downloads the
// models.dev dump into the cache dir so a render never waits on the network.
// The cache covers every model models.dev prices, so a newer binary still falls
// back to its bundled entry for a model an older cache lacks.
const PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_BACKOFF_MS = 60 * 60 * 1000;
// Only reachable when stampAttempt failed: the 1h backoff is checked before the lock.
const REFRESH_LOCK_STALE_MS = 3 * 60 * 1000;
const FETCH_DEADLINE_MS = 30_000;
export const MODEL_PRICES_REFRESH_FLAG = '--internal-refresh-model-prices';

export interface ModelPricesDeps {
    getHomedir: () => string;
    now: () => number;
    getExecPath: () => string;
    getScriptPath: () => string | undefined;
    spawn: typeof spawn;
    /** Aborting `signal` must cancel the download. */
    fetchSource: (signal: AbortSignal) => Promise<ModelsDev>;
    /** Wall-clock budget for the whole download, however the connection stalls. */
    fetchDeadlineMs: number;
}

export function fetchModelsDev(signal: AbortSignal): Promise<ModelsDev> {
    return new Promise((resolve, reject) => {
        const proxyUrl = process.env.HTTPS_PROXY?.trim();
        const request = https.get(MODELS_DEV_URL, {
            signal,
            ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {})
        }, (response) => {
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`GET ${MODELS_DEV_URL} failed: ${response.statusCode}`));
                return;
            }
            let data = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
                data += chunk;
            });
            response.on('end', () => {
                try {
                    resolve(JSON.parse(data) as ModelsDev);
                } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
            response.on('error', reject);
        });
        request.on('error', reject);
    });
}

const DEFAULT_DEPS: ModelPricesDeps = {
    getHomedir: () => os.homedir(),
    now: Date.now,
    getExecPath: () => process.execPath,
    getScriptPath: () => process.argv[1],
    spawn,
    fetchSource: fetchModelsDev,
    fetchDeadlineMs: FETCH_DEADLINE_MS
};

function getCacheDir(deps: ModelPricesDeps): string {
    return path.join(deps.getHomedir(), '.cache', 'ccstatusline');
}

function getPaths(deps: ModelPricesDeps): { cache: string; attempt: string; lock: string } {
    const dir = getCacheDir(deps);
    return {
        cache: path.join(dir, 'model-prices.json'),
        attempt: path.join(dir, 'model-prices.attempt'),
        lock: path.join(dir, 'model-prices.lock')
    };
}

function isNumber(value: unknown): boolean {
    return typeof value === 'number' && Number.isFinite(value);
}

function hasRates(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const rates = value as Record<string, unknown>;
    return isNumber(rates.input)
        && isNumber(rates.output)
        && (rates.cache_read === undefined || isNumber(rates.cache_read))
        && (rates.cache_write === undefined || isNumber(rates.cache_write));
}

function isTier(value: unknown): boolean {
    if (!hasRates(value)) {
        return false;
    }
    const tier = (value as { tier?: unknown }).tier;
    return typeof tier === 'object' && tier !== null
        && typeof (tier as { type?: unknown }).type === 'string'
        && isNumber((tier as { size?: unknown }).size);
}

function isPrice(value: unknown): boolean {
    if (!hasRates(value)) {
        return false;
    }
    const tiers = (value as { tiers?: unknown }).tiers;
    return tiers === undefined || (Array.isArray(tiers) && tiers.every(isTier));
}

/** Parsed cache entries that look like prices; anything else reads as absent. */
function readCachedPrices(cachePath: string, now: number): { prices: ModelPrices; ageMs: number } | null {
    try {
        const parsed = JSON.parse(readFileSync(cachePath, 'utf-8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return null;
        }
        const prices: ModelPrices = {};
        for (const [key, value] of Object.entries(parsed)) {
            // Keys are bare model ids. A provider-prefixed key is the format a
            // previous version wrote, so the whole file predates this one: read
            // it as absent and let the refresh replace it.
            if (key.includes('/')) {
                return null;
            }
            if (isPrice(value)) {
                prices[key] = value as ModelPrices[string];
            }
        }
        return { prices, ageMs: now - statSync(cachePath).mtimeMs };
    } catch {
        return null;
    }
}

function ageOf(filePath: string, deps: ModelPricesDeps): number {
    try {
        return deps.now() - statSync(filePath).mtimeMs;
    } catch {
        return Infinity;
    }
}

function tryCreateLock(lockPath: string, token: string, deps: ModelPricesDeps): boolean {
    try {
        const descriptor = openSync(lockPath, 'wx');
        try {
            writeSync(descriptor, `${process.pid} ${deps.now()} ${token}`);
        } finally {
            closeSync(descriptor);
        }
        return true;
    } catch {
        return false;
    }
}

/** At most one process holds the lock; an abandoned one is taken over once it is stale. */
function claimLock(lockPath: string, token: string, deps: ModelPricesDeps): boolean {
    if (tryCreateLock(lockPath, token, deps)) {
        return true;
    }
    if (ageOf(lockPath, deps) <= REFRESH_LOCK_STALE_MS) {
        return false;
    }
    // rename is atomic, so only one process moves a given stale lock away.
    // It keeps its mtime, which shows whether a live lock was swapped in
    // between our stat and the rename.
    const moved = `${lockPath}.${process.pid}.stale`;
    try {
        renameSync(lockPath, moved);
    } catch {
        return false;
    }
    const wasStale = ageOf(moved, deps) > REFRESH_LOCK_STALE_MS;
    if (!wasStale) {
        try {
            linkSync(moved, lockPath);
        } catch {
            // Someone already created a new lock; theirs stands.
        }
    }
    try {
        unlinkSync(moved);
    } catch {
        // Nothing left to clean.
    }
    return wasStale && tryCreateLock(lockPath, token, deps);
}

function releaseLock(lockPath: string, token: string): void {
    try {
        if (readFileSync(lockPath, 'utf-8').endsWith(token)) {
            unlinkSync(lockPath);
        }
    } catch {
        // Already taken over or removed.
    }
}

/** Stamps the shared retry-after marker; every process reads its mtime. */
function stampAttempt(attemptPath: string): void {
    try {
        writeFileSync(attemptPath, '', 'utf-8');
    } catch {
        // Without a stamp a later render may retry sooner than the backoff.
    }
}

function scheduleRefresh(deps: ModelPricesDeps): void {
    const scriptPath = deps.getScriptPath();
    if (!scriptPath) {
        return;
    }
    const paths = getPaths(deps);
    try {
        mkdirSync(getCacheDir(deps), { recursive: true });
    } catch {
        return;
    }
    if (ageOf(paths.attempt, deps) < RETRY_BACKOFF_MS) {
        return;
    }
    const token = randomBytes(8).toString('hex');
    if (!claimLock(paths.lock, token, deps)) {
        return;
    }
    // The previous holder may have finished between the check above and the claim.
    if (ageOf(paths.attempt, deps) < RETRY_BACKOFF_MS) {
        releaseLock(paths.lock, token);
        return;
    }
    stampAttempt(paths.attempt);
    try {
        const child = deps.spawn(
            deps.getExecPath(),
            [scriptPath, MODEL_PRICES_REFRESH_FLAG, token],
            { detached: true, stdio: 'ignore', windowsHide: true }
        );
        child.unref();
    } catch {
        releaseLock(paths.lock, token);
    }
}

/**
 * Prices for the session cost: the refreshed cache entries over the bundled ones.
 * A missing or stale cache starts a background refresh and this call still
 * returns at once, with whatever is on hand.
 */
export function getModelPrices(deps: ModelPricesDeps = DEFAULT_DEPS): ModelPrices {
    const paths = getPaths(deps);
    const cached = readCachedPrices(paths.cache, deps.now());
    if (cached === null || cached.ageMs > PRICE_CACHE_TTL_MS) {
        scheduleRefresh(deps);
    }
    if (cached === null) {
        return bundledPrices;
    }

    return { ...bundledPrices, ...cached.prices };
}

/** Body of the detached child: download, extract, replace the cache atomically, and stamp the attempt. */
export async function refreshModelPrices(
    token: string,
    deps: ModelPricesDeps = DEFAULT_DEPS
): Promise<void> {
    const paths = getPaths(deps);
    const tmpPath = `${paths.cache}.${process.pid}.tmp`;
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
        const timedOut = new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => {
                controller.abort();
                reject(new Error('models.dev download timed out'));
            }, deps.fetchDeadlineMs);
        });
        const prices = extractModelPrices(await Promise.race([deps.fetchSource(controller.signal), timedOut]));
        writeFileSync(tmpPath, JSON.stringify(prices), 'utf-8');
        renameSync(tmpPath, paths.cache);
    } catch {
        // Keep the previous file; the stamp below delays the next try.
        try {
            unlinkSync(tmpPath);
        } catch {
            // No partial file was written.
        }
    } finally {
        clearTimeout(deadline);
        stampAttempt(paths.attempt);
        releaseLock(paths.lock, token);
    }
}
