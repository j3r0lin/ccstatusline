import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import bundledPrices from '../../data/model-prices.json';
import type { ModelPrices } from '../../types/ModelPrice';
import type { ModelsDev } from '../model-price-extract';
import {
    MODEL_PRICES_REFRESH_FLAG,
    getModelPrices,
    refreshModelPrices,
    type ModelPricesDeps
} from '../model-prices';
import { getSessionCostSummary } from '../session-cost';

import { sourceWithInput } from './fixtures/models-dev-source';

const HOUR = 60 * 60 * 1000;

describe('model prices', () => {
    let home: string;
    let cacheDir: string;
    let cachePath: string;
    let spawned: { command: string; args: string[] }[];
    let fetchCalls: number;
    let fetchResult: () => Promise<ModelsDev>;
    let deps: ModelPricesDeps;

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-prices-'));
        cacheDir = path.join(home, '.cache', 'ccstatusline');
        cachePath = path.join(cacheDir, 'model-prices.json');
        spawned = [];
        fetchCalls = 0;
        fetchResult = () => Promise.resolve(sourceWithInput(7));
        deps = {
            getHomedir: () => home,
            now: Date.now,
            getExecPath: () => '/bin/ccstatusline',
            getScriptPath: () => '/bin/ccstatusline.js',
            spawn: ((command: string, args: string[]) => {
                spawned.push({ command, args });
                return { unref: () => undefined };
            }) as unknown as ModelPricesDeps['spawn'],
            fetchSource: () => {
                fetchCalls++;
                return fetchResult();
            },
            fetchDeadlineMs: 5000
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(home, { recursive: true, force: true });
    });

    function writeCache(content: string, ageMs = 0): void {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(cachePath, content);
        const when = new Date(Date.now() - ageMs);
        fs.utimesSync(cachePath, when, when);
    }

    /** What the detached child would do, run in-process against the lock the parent claimed. */
    async function runSpawnedRefresh(): Promise<void> {
        const call = spawned.at(-1);
        expect(call?.args[1]).toBe(MODEL_PRICES_REFRESH_FLAG);
        await refreshModelPrices(call?.args[2] ?? '', deps);
    }

    it('uses a fresh cache over the bundled prices without refreshing', () => {
        writeCache(JSON.stringify({ 'zai/glm-5.3': { input: 99, output: 99 } }));

        const prices = getModelPrices(deps);

        expect(prices['zai/glm-5.3']).toEqual({ input: 99, output: 99 });
        expect(spawned).toHaveLength(0);
    });

    it('falls back to the bundled entry for keys the cache lacks', () => {
        writeCache(JSON.stringify({ 'zai/glm-5.3': { input: 99, output: 99 } }));

        const prices = getModelPrices(deps);

        expect(prices['moonshotai/kimi-k3']).toEqual((bundledPrices as ModelPrices)['moonshotai/kimi-k3']);
    });

    it('returns bundled prices at once and starts a refresh when the cache is missing', () => {
        expect(getModelPrices(deps)).toEqual(bundledPrices);
        expect(spawned).toHaveLength(1);
        expect(fetchCalls).toBe(0);
    });

    it('serves the stale cache while a refresh starts', () => {
        writeCache(JSON.stringify({ 'zai/glm-5.3': { input: 99, output: 99 } }), 25 * HOUR);

        expect(getModelPrices(deps)['zai/glm-5.3']).toEqual({ input: 99, output: 99 });
        expect(spawned).toHaveLength(1);
    });

    it('starts only one refresh while another is running', () => {
        getModelPrices(deps);
        getModelPrices(deps);

        expect(spawned).toHaveLength(1);
    });

    it('replaces the cache with the downloaded prices after a refresh', async () => {
        getModelPrices(deps);
        await runSpawnedRefresh();

        expect(getModelPrices(deps)['zai/glm-5.3']).toEqual({ input: 7, output: 14 });
        expect(spawned).toHaveLength(1);
    });

    it('keeps the old cache and backs off after a failed refresh', async () => {
        const old = JSON.stringify({ 'zai/glm-5.3': { input: 99, output: 99 } });
        writeCache(old, 25 * HOUR);
        fetchResult = () => Promise.reject(new Error('offline'));

        getModelPrices(deps);
        await runSpawnedRefresh();

        expect(fs.readFileSync(cachePath, 'utf-8')).toBe(old);
        expect(getModelPrices(deps)['zai/glm-5.3']).toEqual({ input: 99, output: 99 });
        expect(spawned).toHaveLength(1);
    });

    it('keeps the old cache when the download lacks a referenced model', async () => {
        const old = JSON.stringify({ 'zai/glm-5.3': { input: 99, output: 99 } });
        writeCache(old, 25 * HOUR);
        fetchResult = () => Promise.resolve({});

        getModelPrices(deps);
        await runSpawnedRefresh();

        expect(fs.readFileSync(cachePath, 'utf-8')).toBe(old);
    });

    it('retries once the backoff has passed', async () => {
        fetchResult = () => Promise.reject(new Error('offline'));
        getModelPrices(deps);
        await runSpawnedRefresh();

        const later = Date.now() + 2 * HOUR;
        getModelPrices({ ...deps, now: () => later });

        expect(spawned).toHaveLength(2);
    });

    it('reads a corrupt cache as bundled prices', () => {
        writeCache('{not json');

        expect(getModelPrices(deps)).toEqual(bundledPrices);
    });

    it('uses the bundled price for one malformed entry and the cache for the rest', () => {
        const fixed = { input: 99, output: 99 };
        const malformed: unknown[] = [
            { input: 1, output: 2, tiers: 'big' },
            { input: 1, output: 2, tiers: [{ input: 1, output: 2, tier: {} }] },
            { input: 1, output: 2, cache_read: 'cheap' },
            { input: 1, output: 2, tiers: [{ output: 2, tier: { type: 'context', size: 1 } }] }
        ];
        for (const bad of malformed) {
            writeCache(JSON.stringify({ 'zai/glm-5.3': bad, 'zai/glm-5.2': fixed }));

            const prices = getModelPrices(deps);

            expect(prices['zai/glm-5.3']).toEqual((bundledPrices as ModelPrices)['zai/glm-5.3']);
            expect(prices['zai/glm-5.2']).toEqual(fixed);
        }
    });

    it('keeps a well-formed tiered entry from the cache', () => {
        const tiered = { input: 1, output: 2, cache_read: 0.5, tiers: [{ input: 3, output: 4, tier: { type: 'context', size: 200_000 } }] };
        writeCache(JSON.stringify({ 'zai/glm-5.3': tiered }));

        expect(getModelPrices(deps)['zai/glm-5.3']).toEqual(tiered);
    });

    it('ignores cache entries that are not prices', () => {
        writeCache(JSON.stringify({ 'zai/glm-5.3': { input: 'free' } }));

        expect(getModelPrices(deps)['zai/glm-5.3']).toEqual((bundledPrices as ModelPrices)['zai/glm-5.3']);
    });

    it('leaves another refresher\'s lock alone when the token does not match', async () => {
        getModelPrices(deps);
        const lock = path.join(cacheDir, 'model-prices.lock');

        await refreshModelPrices('someone-else', deps);

        expect(fs.existsSync(lock)).toBe(true);
    });

    it('takes over a lock left by a crashed refresher', () => {
        fs.mkdirSync(cacheDir, { recursive: true });
        const lock = path.join(cacheDir, 'model-prices.lock');
        fs.writeFileSync(lock, '1 0 dead');
        const old = new Date(Date.now() - 10 * 60 * 1000);
        fs.utimesSync(lock, old, old);

        getModelPrices(deps);

        expect(spawned).toHaveLength(1);
    });

    it('does not take over a lock that is still fresh', () => {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(path.join(cacheDir, 'model-prices.lock'), '1 0 busy');

        getModelPrices(deps);

        expect(spawned).toHaveLength(0);
    });

    it('does not refresh again right after a refresh was started, even before it finishes', () => {
        getModelPrices(deps);
        fs.rmSync(path.join(cacheDir, 'model-prices.lock'));

        getModelPrices(deps);

        expect(spawned).toHaveLength(1);
    });

    it('does not start refreshes for a corrupt cache while backing off', () => {
        writeCache('{not json');
        fs.writeFileSync(path.join(cacheDir, 'model-prices.attempt'), '');

        for (let i = 0; i < 10; i++) {
            expect(getModelPrices(deps)).toEqual(bundledPrices);
        }

        expect(spawned).toHaveLength(0);
    });

    it('gives up on a download that never finishes and frees the lock', async () => {
        const old = JSON.stringify({ 'zai/glm-5.3': { input: 99, output: 99 } });
        writeCache(old, 25 * HOUR);
        let aborted = false;
        deps = {
            ...deps,
            fetchDeadlineMs: 50,
            fetchSource: signal => new Promise<ModelsDev>(() => {
                signal.addEventListener('abort', () => {
                    aborted = true;
                });
            })
        };

        getModelPrices(deps);
        await runSpawnedRefresh();

        expect(aborted).toBe(true);
        expect(fs.readFileSync(cachePath, 'utf-8')).toBe(old);
        expect(fs.existsSync(path.join(cacheDir, 'model-prices.lock'))).toBe(false);
        expect(fs.readdirSync(cacheDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
    });

    it('keeps one session cache version when only prices change', () => {
        const transcript = path.join(home, 't.jsonl');
        const line = (id: string): string => `${JSON.stringify({
            type: 'assistant',
            message: { id, model: 'glm-5.3', usage: { input_tokens: 1_000_000, output_tokens: 0 } }
        })}\n`;
        fs.writeFileSync(transcript, line('m1'));
        vi.spyOn(os, 'homedir').mockReturnValue(home);
        const readVersion = (): string => {
            const file = fs.readdirSync(cacheDir).find(f => f.startsWith('session-cost-')) ?? '';
            return (JSON.parse(fs.readFileSync(path.join(cacheDir, file), 'utf-8')) as { priceVersion: string }).priceVersion;
        };
        const first = getSessionCostSummary(transcript, { 'zai/glm-5.3': { input: 2, output: 4 } });
        const versionBefore = readVersion();
        fs.appendFileSync(transcript, line('m2'));
        // A process holding the refreshed table and one still holding the old table interleave
        const refreshed = getSessionCostSummary(transcript, { 'zai/glm-5.3': { input: 5, output: 4 } });
        const stale = getSessionCostSummary(transcript, { 'zai/glm-5.3': { input: 2, output: 4 } });

        expect(first?.total).toBeCloseTo(2);
        expect(refreshed?.total).toBeCloseTo(10);
        expect(stale?.total).toBeCloseTo(4);
        expect(readVersion()).toBe(versionBefore);
    });

    it('changes the session cost when a refresh changes the prices', () => {
        const transcript = path.join(home, 't.jsonl');
        fs.writeFileSync(transcript, `${JSON.stringify({
            type: 'assistant',
            message: { id: 'm1', model: 'glm-5.3', usage: { input_tokens: 1_000_000, output_tokens: 0 } }
        })}\n`);
        vi.spyOn(os, 'homedir').mockReturnValue(home);
        writeCache(JSON.stringify({ 'zai/glm-5.3': { input: 2, output: 4 } }));
        const before = getSessionCostSummary(transcript, getModelPrices(deps));
        writeCache(JSON.stringify({ 'zai/glm-5.3': { input: 5, output: 4 } }));
        const after = getSessionCostSummary(transcript, getModelPrices(deps));

        expect(before?.total).toBeCloseTo(2);
        expect(after?.total).toBeCloseTo(5);
    });
});
