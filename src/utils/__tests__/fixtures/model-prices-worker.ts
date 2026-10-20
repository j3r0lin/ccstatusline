// One status-line render's worth of price handling, run as its own process by
// model-prices-concurrency.test.ts. Spawning the refresh child is replaced by
// running its body in-process, with a slow fake download that logs itself.
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { getReferencedPriceKeys } from '../../model-price-aliases';
import type { ModelsDev } from '../../model-price-extract';
import {
    getModelPrices,
    refreshModelPrices,
    type ModelPricesDeps
} from '../../model-prices';

const home = process.env.PRICES_TEST_HOME ?? '';
const log = process.env.PRICES_TEST_LOG ?? '';

const source: ModelsDev = {};
for (const key of getReferencedPriceKeys()) {
    const slash = key.indexOf('/');
    const provider = key.slice(0, slash);
    source[provider] ??= { models: {} };
    source[provider].models ??= {};
    source[provider].models[key.slice(slash + 1)] = { cost: { input: 7, output: 14 } };
}

let pending: Promise<void> = Promise.resolve();
const deps: ModelPricesDeps = {
    getHomedir: () => home,
    now: Date.now,
    getExecPath: () => '',
    getScriptPath: () => 'worker',
    spawn: ((_command: string, args: string[]) => {
        appendFileSync(log, 'spawn\n');
        pending = refreshModelPrices(args[2] ?? '', deps);
        return { unref: () => undefined };
    }) as unknown as ModelPricesDeps['spawn'],
    fetchSource: async () => {
        appendFileSync(log, 'download\n');
        await sleep(400);
        return source;
    },
    fetchDeadlineMs: 5000
};

// Keep reading while the refresh renames its file into place
let bad = 0;
const until = Date.now() + 900;
getModelPrices(deps);
while (Date.now() < until) {
    const prices = getModelPrices(deps);
    for (const key of getReferencedPriceKeys()) {
        if (typeof prices[key]?.input !== 'number') {
            bad++;
        }
    }
    await sleep(2);
}
await pending;
console.log(`bad=${bad} glm=${getModelPrices(deps)['zai/glm-5.3']?.input}`);
