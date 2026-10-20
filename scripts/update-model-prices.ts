#!/usr/bin/env bun

import {
    readFileSync,
    writeFileSync
} from 'node:fs';
import { join } from 'node:path';

import {
    extractModelPrices,
    type ModelsDev
} from '../src/utils/model-price-extract';
import { fetchModelsDev } from '../src/utils/model-prices';

const OUTPUT_PATH = join(import.meta.dir, '..', 'src', 'data', 'model-prices.json');

async function loadSource(arg: string | undefined): Promise<ModelsDev> {
    if (arg) {
        return JSON.parse(readFileSync(arg, 'utf-8')) as ModelsDev;
    }
    return await fetchModelsDev(AbortSignal.timeout(60_000));
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
