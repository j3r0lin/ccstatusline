import { getReferencedPriceKeys } from '../../model-price-aliases';
import type { ModelsDev } from '../../model-price-extract';

/** A models.dev dump carrying every referenced key at the given input price. */
export function sourceWithInput(input: number): ModelsDev {
    const source: ModelsDev = {};
    for (const key of getReferencedPriceKeys()) {
        const slash = key.indexOf('/');
        const provider = key.slice(0, slash);
        source[provider] ??= { models: {} };
        source[provider].models ??= {};
        source[provider].models[key.slice(slash + 1)] = { cost: { input, output: input * 2 } };
    }
    return source;
}
