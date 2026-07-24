import type { RenderContext } from '../types';

import {
    getContextWindowMetrics,
    resolveContextLengthTokens
} from './context-window';
import {
    getContextConfig,
    getModelContextIdentifier
} from './model-context';

export interface ContextPercentageMetrics {
    usedPercentage: number;
    windowSize: number | null;
}

/**
 * Calculate context window usage percentage and the denominator used for that
 * percentage. Returns null when neither status JSON nor transcript metrics can
 * provide context usage.
 */
export function calculateContextPercentageMetrics(context: Pick<RenderContext, 'data' | 'tokenMetrics'>): ContextPercentageMetrics | null {
    const contextWindowMetrics = getContextWindowMetrics(context.data);
    const modelIdentifier = getModelContextIdentifier(context.data?.model);
    const contextConfig = getContextConfig(modelIdentifier, contextWindowMetrics.windowSize);

    // Prefer an explicit non-zero status percentage. A zero percentage is often a
    // placeholder on non-Anthropic model paths while the transcript already has
    // the real context length — fall through and recompute from resolved length.
    if (contextWindowMetrics.usedPercentage !== null && contextWindowMetrics.usedPercentage > 0) {
        return {
            usedPercentage: contextWindowMetrics.usedPercentage,
            windowSize: contextConfig.maxTokens
        };
    }

    const resolvedLength = resolveContextLengthTokens(contextWindowMetrics, context.tokenMetrics);
    if (resolvedLength === null) {
        return null;
    }

    return {
        usedPercentage: Math.min(100, (resolvedLength / contextConfig.maxTokens) * 100),
        windowSize: contextConfig.maxTokens
    };
}

/**
 * Calculate context window usage percentage based on model's max tokens.
 */
export function calculateContextPercentage(context: RenderContext): number {
    return calculateContextPercentageMetrics(context)?.usedPercentage ?? 0;
}
