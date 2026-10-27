import type { ModelsDev } from '../../model-price-extract';

/** A models.dev dump pricing a handful of ids, enough for the cache and refresh paths. */
export function sourceWithInput(input: number): ModelsDev {
    return {
        'anthropic': { models: { 'claude-opus-5-5': { cost: { input, output: input * 2 } } } },
        'openai': {
            models: {
                // The gateway's own casing, which the extractor lowercases
                'GPT-6.1-Terra': { cost: { input, output: input * 2 } }
            }
        },
        'zai': {
            models: {
                'glm-5.3': { cost: { input, output: input * 2 } },
                'glm-5.2': { cost: { input, output: input * 2 } }
            }
        },
        'opencode-go': { models: { 'kimi-k3': { cost: { input, output: input * 2 } } } }
    };
}
