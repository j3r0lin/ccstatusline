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

const SUFFIXES = [
    // Claude Code marks the 1M context window, e.g. `claude-opus-5-5[1m]`
    /\[[^\]]*\]$/,
    // Dated snapshots are priced as the alias they point at, e.g. `claude-sonnet-4-5-20250929`
    /-\d{8}$/,
    // Free and highspeed variants are priced as the paid model: the widget reports
    // API-equivalent consumption, not what the gateway billed.
    /-free$/,
    /-highspeed$/
];

/** Lowercase, with the suffixes a gateway and Claude Code add stripped, ready to match an id. */
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

/** The model's price, or undefined when the table holds none for it. */
export function getModelPrice(prices: ModelPrices, model: string): ModelPrice | undefined {
    const name = normalizeModelName(model);
    return prices[MODEL_PRICE_ALIASES[name] ?? name];
}
