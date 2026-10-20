import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import bundledPrices from '../../data/model-prices.json';
import type { ModelPrices } from '../../types/ModelPrice';
import { getReferencedPriceKeys } from '../model-price-aliases';
import type { ModelsDev } from '../model-price-extract';
import {
    MODEL_PRICES_REFRESH_FLAG,
    getModelPrices,
    refreshModelPrices,
    type ModelPricesDeps
} from '../model-prices';
import { getSessionCostSummary } from '../session-cost';

const HOUR = 60 * 60 * 1000;

/** A models.dev dump carrying every referenced key at the given input price. */
function sourceWithInput(input: number): ModelsDev {
    const source: ModelsDev = {};
    for (const key of getReferencedPriceKeys()) {
        const slash = key.indexOf('/');
        const provider = key.slice(0, slash);
        source[provider] ??= { models: {} };
        source[provider].models ??= {};
        source[provider].models[key.slice(slash + 1)] = { cost: { input, output: input * 2 } };
    }
    return source;
}

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
            }
        };
    });

    afterEach(() => {
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

    it('ignores cache entries that are not prices', () => {
        writeCache(JSON.stringify({ 'zai/glm-5.3': { input: 'free' } }));

        expect(getModelPrices(deps)['zai/glm-5.3']).toEqual((bundledPrices as ModelPrices)['zai/glm-5.3']);
    });

    it('does not release a lock path it did not claim', async () => {
        const stray = path.join(home, 'stray');
        fs.writeFileSync(stray, '');

        await refreshModelPrices(stray, deps);

        expect(fs.existsSync(stray)).toBe(true);
        expect(fetchCalls).toBe(0);
    });

    it('changes the session cost when a refresh changes the prices', () => {
        const transcript = path.join(home, 't.jsonl');
        fs.writeFileSync(transcript, `${JSON.stringify({
            type: 'assistant',
            message: { id: 'm1', model: 'glm-5.3', usage: { input_tokens: 1_000_000, output_tokens: 0 } }
        })}\n`);
        const homedir = os.homedir;
        os.homedir = () => home;
        try {
            writeCache(JSON.stringify({ 'zai/glm-5.3': { input: 2, output: 4 } }));
            const before = getSessionCostSummary(transcript, getModelPrices(deps));
            writeCache(JSON.stringify({ 'zai/glm-5.3': { input: 5, output: 4 } }));
            const after = getSessionCostSummary(transcript, getModelPrices(deps));

            expect(before?.total).toBeCloseTo(2);
            expect(after?.total).toBeCloseTo(5);
        } finally {
            os.homedir = homedir;
        }
    });
});
