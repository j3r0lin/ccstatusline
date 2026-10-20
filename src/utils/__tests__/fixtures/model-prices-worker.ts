// One status-line render's worth of price handling, run as its own process by
// model-prices-concurrency.test.ts. Spawning the refresh child is replaced by
// running its body in-process, with a slow fake download that logs itself.
import {
    appendFileSync,
    existsSync,
    readFileSync
} from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { getReferencedPriceKeys } from '../../model-price-aliases';
import {
    getModelPrices,
    refreshModelPrices,
    type ModelPricesDeps
} from '../../model-prices';

import { sourceWithInput } from './models-dev-source';

const home = process.env.PRICES_TEST_HOME ?? '';
const log = process.env.PRICES_TEST_LOG ?? '';

const source = sourceWithInput(7);

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

// Keep reading the raw file while the refresh renames it into place: whenever
// it exists it must parse and hold the whole table, or a reader saw a partial write.
const cachePath = path.join(home, '.cache', 'ccstatusline', 'model-prices.json');
let bad = 0;
const until = Date.now() + 900;
getModelPrices(deps);
while (Date.now() < until) {
    getModelPrices(deps);
    if (existsSync(cachePath)) {
        try {
            const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
            if (getReferencedPriceKeys().some(key => !(key in raw))) {
                bad++;
            }
        } catch {
            bad++;
        }
    }
    await sleep(2);
}
await pending;
console.log(`bad=${bad} glm=${getModelPrices(deps)['zai/glm-5.3']?.input}`);
