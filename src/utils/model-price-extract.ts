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
 * Each vendor comes before its regional arm, whose numbers are a local-currency conversion.
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

/**
 * Model id prefix -> the provider that makes that model.
 *
 * @remarks
 * The global order alone loses to a reseller whenever a vendor is not in `PROVIDER_PRIORITY`:
 * `alibaba` also carries Qwen, and lists it with its own cache-read rate. Checking the family
 * first keeps a vendor's own numbers for its models wherever it sits in the global order.
 * The family name must end there: followed by the end, a separator, or a version digit, never
 * by another letter, so `gpt` does not also claim a model that merely starts with those letters.
 */
const MODEL_FAMILIES: [prefix: string, provider: string][] = [
    ['claude', 'anthropic'],
    ['fable', 'anthropic'],
    ['gpt', 'openai'],
    ['grok', 'xai'],
    ['gemini', 'google'],
    ['gemma', 'google'],
    ['glm', 'zai'],
    ['qwen', 'alibaba'],
    ['qwq', 'alibaba'],
    ['deepseek', 'deepseek'],
    ['kimi', 'moonshotai'],
    ['k3', 'moonshotai'],
    ['minimax', 'minimax'],
    ['mimo', 'xiaomi'],
    ['mistral', 'mistral'],
    ['devstral', 'mistral'],
    ['pixtral', 'mistral'],
    ['command', 'cohere'],
    ['jamba', 'ai21'],
    ['muse', 'meta']
];

function familyProvider(id: string): string | undefined {
    return MODEL_FAMILIES.find(([prefix]) => new RegExp(`^${prefix}(?![a-z])`).test(id))?.[1];
}

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
    const providers = providerOrder(Object.keys(source));
    const prices = new Map<string, ModelPrice>();

    for (const provider of providers) {
        for (const [rawId, entry] of Object.entries(source[provider]?.models ?? {})) {
            const id = rawId.toLowerCase();
            const cost = entry.cost;
            // A model's own vendor wins over whoever else lists it, whatever the global order
            if (cost === undefined || id.includes('/') || familyProvider(id) === provider) {
                continue;
            }
            if (!prices.has(id)) {
                prices.set(id, pickCost(cost));
            }
        }
    }

    // The vendor's entry replaces the one the global order picked for its family's models
    for (const provider of providers) {
        for (const [rawId, entry] of Object.entries(source[provider]?.models ?? {})) {
            const id = rawId.toLowerCase();
            if (entry.cost !== undefined && !id.includes('/') && familyProvider(id) === provider) {
                prices.set(id, pickCost(entry.cost));
            }
        }
    }

    if (prices.size === 0) {
        throw new Error('models.dev returned no priced models');
    }
    return Object.fromEntries([...prices].sort(([a], [b]) => (a < b ? -1 : 1)));
}
