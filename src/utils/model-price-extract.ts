import type {
    ModelPrice,
    ModelPrices
} from '../types/ModelPrice';

import { getReferencedPriceKeys } from './model-price-aliases';

export type ModelsDev = Record<string, { models?: Record<string, { cost?: ModelPrice }> } | undefined>;

export const MODELS_DEV_URL = 'https://models.dev/api.json';

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

/** Trims a models.dev dump to the prices the alias table references; throws when one is missing. */
export function extractModelPrices(source: ModelsDev): ModelPrices {
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
        throw new Error(`models.dev has no price for: ${missing.join(', ')}`);
    }
    return prices;
}
