import type {
    ModelPrice,
    ModelPrices
} from '../types/ModelPrice';

export type ModelsDev = Record<string, { models?: Record<string, { cost?: ModelPrice }> | undefined } | undefined>;

export const MODELS_DEV_URL = 'https://models.dev/api.json';

/**
 * Providers whose listing of a model is that model's own price, ahead of everyone else.
 *
 * @remarks
 * First entry wins, so the order settles every id several providers carry. Each vendor
 * comes before its regional arm, whose numbers are a local-currency conversion.
 * `opencode-go` follows the vendors as the gateway the status line is usually routed
 * through; a reseller that also carries another vendor's model (`alibaba`, `302ai`,
 * `requesty`) must come after it, or it would price DeepSeek and Kimi at its own markup.
 * Every other provider sorts alphabetically after these.
 */
const PROVIDER_PRIORITY = [
    'anthropic',
    'openai',
    'google',
    'xai',
    'deepseek',
    'moonshotai',
    'moonshotai-cn',
    'zai',
    'zhipuai',
    'minimax',
    'minimax-cn',
    'meta',
    'mistral',
    'cohere',
    'xiaomi',
    'opencode-go'
];

function providerOrder(providers: string[]): string[] {
    const ranked = PROVIDER_PRIORITY.filter(provider => providers.includes(provider));
    const rest = providers.filter(provider => !ranked.includes(provider)).sort();
    return [...ranked, ...rest];
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

/**
 * Trims a models.dev dump to a price per model id.
 *
 * @remarks
 * Ids are lowercased because models.dev mixes casings (`MiniMax-M2.5`, `GLM-5.1`) while
 * gateways report either. An id containing `/` names another provider's model rather than
 * one of its own, and is skipped. A price that comes out empty means the download carried
 * nothing usable; that throws so a refresh keeps the previous table instead of wiping it.
 */
export function extractModelPrices(source: ModelsDev): ModelPrices {
    const prices = new Map<string, ModelPrice>();

    for (const provider of providerOrder(Object.keys(source))) {
        for (const [rawId, entry] of Object.entries(source[provider]?.models ?? {})) {
            const id = rawId.toLowerCase();
            const cost = entry.cost;
            if (cost === undefined || id.includes('/') || prices.has(id)) {
                continue;
            }
            prices.set(id, pickCost(cost));
        }
    }

    if (prices.size === 0) {
        throw new Error('models.dev returned no priced models');
    }
    return Object.fromEntries([...prices].sort(([a], [b]) => (a < b ? -1 : 1)));
}
