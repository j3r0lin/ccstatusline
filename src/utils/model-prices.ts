import { spawn } from 'child_process';
import {
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync
} from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import bundledJson from '../data/model-prices.json';
import type { ModelPrices } from '../types/ModelPrice';

import { getReferencedPriceKeys } from './model-price-aliases';
import {
    MODELS_DEV_URL,
    extractModelPrices,
    type ModelsDev
} from './model-price-extract';

const bundledPrices: ModelPrices = bundledJson;

// Prices ship in the binary but go stale; a detached child re-downloads the
// models.dev dump into the cache dir so a render never waits on the network.
// The cache holds only what the alias table references, so a newer binary
// falls back to its bundled entry for keys an older cache lacks.
const PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_BACKOFF_MS = 60 * 60 * 1000;
const REFRESH_LOCK_STALE_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;
export const MODEL_PRICES_REFRESH_FLAG = '--internal-refresh-model-prices';

export interface ModelPricesDeps {
    getHomedir: () => string;
    now: () => number;
    getExecPath: () => string;
    getScriptPath: () => string | undefined;
    spawn: typeof spawn;
    fetchSource: () => Promise<ModelsDev>;
}

function fetchModelsDev(): Promise<ModelsDev> {
    return new Promise((resolve, reject) => {
        const proxyUrl = process.env.HTTPS_PROXY?.trim();
        const request = https.get(MODELS_DEV_URL, {
            timeout: FETCH_TIMEOUT_MS,
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
        request.on('timeout', () => {
            request.destroy(new Error('models.dev request timed out'));
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
    fetchSource: fetchModelsDev
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

function isPrice(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as { input?: unknown; output?: unknown };
    return typeof candidate.input === 'number' && typeof candidate.output === 'number';
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

function claimLock(lockPath: string, deps: ModelPricesDeps): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            closeSync(openSync(lockPath, 'wx'));
            return true;
        } catch {
            if (ageOf(lockPath, deps) <= REFRESH_LOCK_STALE_MS) {
                return false;
            }
            try {
                unlinkSync(lockPath);
            } catch {
                return false;
            }
        }
    }
    return false;
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
    if (ageOf(paths.attempt, deps) < RETRY_BACKOFF_MS || !claimLock(paths.lock, deps)) {
        return;
    }
    try {
        const child = deps.spawn(
            deps.getExecPath(),
            [scriptPath, MODEL_PRICES_REFRESH_FLAG, paths.lock],
            { detached: true, stdio: 'ignore', windowsHide: true }
        );
        child.unref();
    } catch {
        try {
            unlinkSync(paths.lock);
        } catch {
            // A stale lock is reclaimed after REFRESH_LOCK_STALE_MS.
        }
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

    const prices: ModelPrices = {};
    for (const key of getReferencedPriceKeys()) {
        const price: ModelPrices[string] | undefined = cached.prices[key] ?? bundledPrices[key];
        if (price !== undefined) {
            prices[key] = price;
        }
    }
    return prices;
}

/** Body of the detached child: download, extract, replace the cache atomically, and stamp the attempt. */
export async function refreshModelPrices(
    lockPath: string,
    deps: ModelPricesDeps = DEFAULT_DEPS
): Promise<void> {
    const paths = getPaths(deps);
    // Only touch the lock path derived from the cache dir, so the internal
    // flag can't be abused into an arbitrary file delete.
    if (lockPath !== paths.lock) {
        return;
    }
    try {
        const prices = extractModelPrices(await deps.fetchSource());
        const tmpPath = `${paths.cache}.${process.pid}.tmp`;
        writeFileSync(tmpPath, JSON.stringify(prices), 'utf-8');
        renameSync(tmpPath, paths.cache);
    } catch {
        // Keep the previous file; the attempt stamp below delays the next try.
    } finally {
        try {
            writeFileSync(paths.attempt, '', 'utf-8');
        } catch {
            // Without a stamp the next render may retry sooner than the backoff.
        }
        try {
            unlinkSync(paths.lock);
        } catch {
            // Already reclaimed as stale.
        }
    }
}
