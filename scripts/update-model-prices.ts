#!/usr/bin/env bun

import {
    readFileSync,
    writeFileSync
} from 'node:fs';
import { join } from 'node:path';

import {
    MODELS_DEV_URL,
    extractModelPrices,
    type ModelsDev
} from '../src/utils/model-price-extract';

const OUTPUT_PATH = join(import.meta.dir, '..', 'src', 'data', 'model-prices.json');

async function loadSource(arg: string | undefined): Promise<ModelsDev> {
    if (arg) {
        return JSON.parse(readFileSync(arg, 'utf-8')) as ModelsDev;
    }
    // Bun's fetch honors HTTPS_PROXY
    const response = await fetch(MODELS_DEV_URL);
    if (!response.ok) {
        throw new Error(`GET ${MODELS_DEV_URL} failed: ${response.status}`);
    }
    return await response.json() as ModelsDev;
}

let prices;
try {
    prices = extractModelPrices(await loadSource(process.argv[2]));
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}

writeFileSync(OUTPUT_PATH, `${JSON.stringify(prices, null, 2)}\n`, 'utf-8');
console.log(`Wrote ${Object.keys(prices).length} prices to ${OUTPUT_PATH}`);
