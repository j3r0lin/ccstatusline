import {
    describe,
    expect,
    it
} from 'vitest';

import type { ModelPrices } from '../../types/ModelPrice';
import { extractModelPrices } from '../model-price-extract';
import {
    getModelPrice,
    normalizeModelName
} from '../model-price-lookup';

const PRICES: ModelPrices = {
    'gpt-6.1-terra': { input: 1, output: 5 },
    'glm-5.3-flash': { input: 0.15, output: 0.5 },
    'deepseek-v4.1-flash': { input: 0.15, output: 0.6 },
    'claude-opus-5-5': { input: 4, output: 20 },
    'claude-sonnet-4-5': { input: 3, output: 15 },
    'claude-3-7-sonnet-20250219': { input: 3, output: 15 },
    'fugu-ultra': { input: 4, output: 24 },
    'fugu-ultra-20260615': { input: 5, output: 30 },
    'kimi-k3': { input: 3, output: 15 },
    'grok-4.7': { input: 2, output: 6 },
    'minimax-m2.5': { input: 0.3, output: 1.2 }
};

describe('model price lookup', () => {
    it('prices a model by its name', () => {
        expect(getModelPrice(PRICES, 'gpt-6.1-terra')).toEqual({ input: 1, output: 5 });
    });

    it('ignores the casing a gateway reports', () => {
        expect(getModelPrice(PRICES, 'GLM-5.3-Flash')).toEqual({ input: 0.15, output: 0.5 });
        expect(getModelPrice(PRICES, 'MiniMax-M2.5')).toEqual({ input: 0.3, output: 1.2 });
    });

    it('strips the suffix Claude Code adds for the 1M context window', () => {
        expect(getModelPrice(PRICES, 'claude-opus-5-5[1m]')).toEqual({ input: 4, output: 20 });
        expect(normalizeModelName('Claude-Opus-5-5[1m]')).toBe('claude-opus-5-5');
    });

    it('prices a dated snapshot as the model it snapshots when the date itself has no price', () => {
        expect(getModelPrice(PRICES, 'claude-sonnet-4-5-20250929')).toEqual({ input: 3, output: 15 });
        expect(getModelPrice(PRICES, 'claude-3-7-sonnet-20250219')).toEqual({ input: 3, output: 15 });
    });

    it('takes the dated id price over the base model price when models.dev lists one', () => {
        expect(getModelPrice(PRICES, 'fugu-ultra-20260615')).toEqual({ input: 5, output: 30 });
        expect(getModelPrice(PRICES, 'fugu-ultra')).toEqual({ input: 4, output: 24 });
    });

    it('prices a routed model name by the segment after the route or provider', () => {
        expect(getModelPrice(PRICES, 'codex/gpt-6.1-terra')).toEqual({ input: 1, output: 5 });
        expect(getModelPrice(PRICES, 'group/deepseek-v4.1-flash')).toEqual({ input: 0.15, output: 0.6 });
        expect(getModelPrice(PRICES, 'zai-org/GLM-5.3-Flash')).toEqual({ input: 0.15, output: 0.5 });
        expect(getModelPrice(PRICES, 'tars/antigravity/kimi-k3')).toEqual({ input: 3, output: 15 });
    });

    it('follows an alias and strips suffixes on a routed model name too', () => {
        expect(getModelPrice(PRICES, 'kimi/k3-256k')).toEqual({ input: 3, output: 15 });
        expect(getModelPrice(PRICES, 'other/claude-opus-5-5[1m]')).toEqual({ input: 4, output: 20 });
    });

    it('prices a free or highspeed variant at the paid model price', () => {
        expect(getModelPrice(PRICES, 'glm-5.3-flash-free')).toEqual({ input: 0.15, output: 0.5 });
        expect(getModelPrice(PRICES, 'kimi-k3-highspeed')).toEqual({ input: 3, output: 15 });
    });

    it('follows an alias for a name models.dev does not carry', () => {
        expect(getModelPrice(PRICES, 'k3')).toEqual({ input: 3, output: 15 });
        expect(getModelPrice(PRICES, 'k3-256k')).toEqual({ input: 3, output: 15 });
        expect(getModelPrice(PRICES, 'grok-4.7-build')).toEqual({ input: 2, output: 6 });
    });

    it('follows an alias after stripping a suffix, and prices the free variant the same', () => {
        expect(getModelPrice(PRICES, 'k3-free')).toEqual({ input: 3, output: 15 });
        expect(getModelPrice(PRICES, 'k3-256k-highspeed')).toEqual({ input: 3, output: 15 });
    });

    it('has no price for an unknown name', () => {
        expect(getModelPrice(PRICES, 'mystery-model')).toBeUndefined();
    });
});

describe('extracting prices from a models.dev dump', () => {
    it('prices every model carrying a cost, keyed by the bare model id', () => {
        const prices = extractModelPrices({
            openai: {
                models: {
                    'gpt-6.1-terra': { cost: { input: 1, output: 5 } },
                    'no-cost-model': {}
                }
            }
        });

        expect(prices).toEqual({ 'gpt-6.1-terra': { input: 1, output: 5 } });
    });

    it('skips an id written as provider/model', () => {
        const prices = extractModelPrices({
            nvidia: {
                models: {
                    'moonshotai/kimi-k3': { cost: { input: 3, output: 15 } },
                    'llama-4': { cost: { input: 1, output: 2 } }
                }
            }
        });

        expect(prices).toEqual({ 'llama-4': { input: 1, output: 2 } });
    });

    it('prices a routed name even though extraction skips prefixed ids', () => {
        const prices = extractModelPrices({ openai: { models: { 'gpt-6.1-terra': { cost: { input: 1, output: 5 } } } } });

        expect(getModelPrice(prices, 'codex/gpt-6.1-terra')).toEqual({ input: 1, output: 5 });
    });

    it('takes the price from the vendor ahead of a reseller', () => {
        const prices = extractModelPrices({
            'some-reseller': { models: { 'gpt-6.1-terra': { cost: { input: 9, output: 9 } } } },
            'openai': { models: { 'gpt-6.1-terra': { cost: { input: 1, output: 5 } } } }
        });

        expect(prices['gpt-6.1-terra']).toEqual({ input: 1, output: 5 });
    });

    it('takes the remaining providers in a set order so a shared id is stable', () => {
        const source = (): Record<string, { models: Record<string, { cost: { input: number; output: number } }> }> => ({
            zeta: { models: { shared: { cost: { input: 2, output: 2 } } } },
            alpha: { models: { shared: { cost: { input: 1, output: 1 } } } }
        });

        const reversed = source();
        const entries = Object.entries(reversed).reverse();
        const fromReverse = extractModelPrices(Object.fromEntries(entries));
        expect(extractModelPrices(source()).shared).toEqual({ input: 1, output: 1 });
        expect(fromReverse.shared).toEqual({ input: 1, output: 1 });
    });

    it('matches case-insensitively across providers', () => {
        const prices = extractModelPrices({ elsewhere: { models: { 'GLM-5.1': { cost: { input: 1, output: 2 } } } } });

        expect(prices['glm-5.1']).toEqual({ input: 1, output: 2 });
    });

    it('keeps the context tiers and drops other tier kinds', () => {
        const prices = extractModelPrices({
            xai: {
                models: {
                    'grok-4.7': {
                        cost: {
                            input: 2,
                            output: 6,
                            tiers: [
                                { input: 4, output: 12, tier: { type: 'context', size: 200_000 } },
                                { input: 8, output: 24, tier: { type: 'batch', size: 1 } }
                            ]
                        }
                    }
                }
            }
        });

        expect(prices['grok-4.7']?.tiers).toEqual([
            { input: 4, output: 12, tier: { type: 'context', size: 200_000 } }
        ]);
    });

    it('fails rather than reporting an empty table when the dump carries no priced model', () => {
        expect(() => extractModelPrices({ openai: { models: { bare: {} } } })).toThrow();
    });
});
