import type {
    ModelPrice,
    ModelPrices
} from '../types/ModelPrice';

/**
 * Transcript model name -> models.dev model id, for names that do not match an id themselves.
 *
 * `k3*` and `kimi-for-coding` are the gateway's names for Kimi's models. models.dev carries
 * those names only under the Kimi coding plans, priced at zero, so they are pointed at the
 * paid ids the plans resell. `grok-4.7-build` is the gateway's name for xAI's build tier.
 */
export const MODEL_PRICE_ALIASES: Record<string, string> = {
    'k3': 'kimi-k3',
    'k3-256k': 'kimi-k3',
    'k3.1-pro': 'kimi-k3.1-pro',
    'kimi-for-coding': 'kimi-k3',
    'grok-4.7-build': 'grok-4.7'
};

/** Suffixes a gateway and Claude Code add that are priced as the model they decorate. */
const SUFFIXES = [
    // Claude Code marks the 1M context window, e.g. `claude-opus-5-5[1m]`
    /\[[^\]]*\]$/,
    // Free and highspeed variants are priced as the paid model: the widget reports
    // API-equivalent consumption, not what the gateway billed.
    /-free$/,
    /-highspeed$/
];

// Dated snapshots carry their own price where models.dev lists one (`fugu-ultra-20260615`),
// so the date is only dropped when the dated id misses.
const DATE_SUFFIX = /-\d{8}$/;

/** Lowercase, with the suffixes priced as the model they decorate stripped. */
export function normalizeModelName(model: string): string {
    let name = model.toLowerCase();
    for (const suffix of SUFFIXES) {
        name = name.replace(suffix, '');
    }
    return name;
}

/** True for Claude models as the transcript names them, `[1m]` and date suffixes included. */
export function isClaudeModel(model: string): boolean {
    return model.startsWith('claude-');
}

function findPrice(prices: ModelPrices, model: string): ModelPrice | undefined {
    const name = normalizeModelName(model);
    return prices[MODEL_PRICE_ALIASES[name] ?? name] ?? prices[name.replace(DATE_SUFFIX, '')];
}

/**
 * The model's price, or undefined when the table holds none for it.
 *
 * @remarks
 * A routed session records the provider or route group in front of the model
 * (`codex/gpt-6-luna`, `tars/antigravity/gemini-3.8-flash`), so the segment after the last
 * `/` is tried when the whole name misses.
 */
export function getModelPrice(prices: ModelPrices, model: string): ModelPrice | undefined {
    const bare = model.slice(model.lastIndexOf('/') + 1);
    return findPrice(prices, model) ?? (bare === model ? undefined : findPrice(prices, bare));
}
