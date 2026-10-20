#!/usr/bin/env bun

import {
    readFileSync,
    writeFileSync
} from 'node:fs';
import { join } from 'node:path';

import type {
    ModelPrice,
    ModelPrices
} from '../src/types/ModelPrice';
import { getReferencedPriceKeys } from '../src/utils/model-price-aliases';

type ModelsDev = Record<string, { models?: Record<string, { cost?: ModelPrice }> } | undefined>;

const SOURCE_URL = 'https://models.dev/api.json';
const OUTPUT_PATH = join(import.meta.dir, '..', 'src', 'data', 'model-prices.json');

async function loadSource(arg: string | undefined): Promise<ModelsDev> {
    if (arg) {
        return JSON.parse(readFileSync(arg, 'utf-8')) as ModelsDev;
    }
    // Bun's fetch honors HTTPS_PROXY
    const response = await fetch(SOURCE_URL);
    if (!response.ok) {
        throw new Error(`GET ${SOURCE_URL} failed: ${response.status}`);
    }
    return await response.json() as ModelsDev;
}

function pickCost(cost: ModelPrice): ModelPrice {
    const picked: ModelPrice = { input: cost.input, output: cost.output };
    if (cost.cache_read !== undefined) {
        picked.cache_read = cost.cache_read;
    }
    if (cost.cache_write !== undefined) {
        picked.cache_write = cost.cache_write;
    }
    const tiers = cost.tiers?.filter(t => t.tier.type === 'context');
    if (tiers && tiers.length > 0) {
        picked.tiers = tiers.map(t => ({
            input: t.input,
            output: t.output,
            ...(t.cache_read !== undefined ? { cache_read: t.cache_read } : {}),
            ...(t.cache_write !== undefined ? { cache_write: t.cache_write } : {}),
            tier: { type: t.tier.type, size: t.tier.size }
        }));
    }
    return picked;
}

const source = await loadSource(process.argv[2]);
const prices: ModelPrices = {};
const missing: string[] = [];

for (const key of getReferencedPriceKeys()) {
    const slash = key.indexOf('/');
    const cost = source[key.slice(0, slash)]?.models?.[key.slice(slash + 1)]?.cost;
    if (cost === undefined) {
        missing.push(key);
    } else {
        prices[key] = pickCost(cost);
    }
}

if (missing.length > 0) {
    console.error(`models.dev has no price for: ${missing.join(', ')}`);
    process.exit(1);
}

writeFileSync(OUTPUT_PATH, `${JSON.stringify(prices, null, 2)}\n`, 'utf-8');
console.log(`Wrote ${Object.keys(prices).length} prices to ${OUTPUT_PATH}`);
