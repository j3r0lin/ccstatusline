/** USD per 1M tokens above a prompt size, replacing the base prices whole. */
export interface PriceTier {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    tier: {
        type: string;
        size: number;
    };
}

/** One models.dev cost entry, trimmed to the fields the session cost needs. */
export interface ModelPrice {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    tiers?: PriceTier[];
}

export type ModelPrices = Record<string, ModelPrice>;
