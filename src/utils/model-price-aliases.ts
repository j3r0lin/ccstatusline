/** Claude models priced from models.dev; their keys equal the transcript model name. */
export const CLAUDE_PRICED_MODELS = [
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-4-5',
    'claude-sonnet-5-5',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-5-5',
    'claude-haiku-4-5',
    'claude-fable-5-1',
    'claude-fable-5'
] as const;

/**
 * Transcript model name -> models.dev `provider/key`.
 *
 * `-free` and highspeed variants are priced as the paid model on purpose: the
 * widget reports API-equivalent consumption, not what the gateway billed.
 */
export const NON_CLAUDE_MODEL_ALIASES: Record<string, string> = {
    'k3': 'moonshotai/kimi-k3',
    'k3-256k': 'moonshotai/kimi-k3',
    'kimi-for-coding': 'moonshotai/kimi-k3',
    'kimi-for-coding-highspeed': 'moonshotai/kimi-k3',
    'gpt-6.1-sol': 'openai/gpt-6.1-sol',
    'grok-4.7': 'xai/grok-4.7',
    'grok-4.7-build': 'xai/grok-4.7',
    'glm-5.3': 'zai/glm-5.3',
    'glm-5.3-flash': 'zai/glm-5.3-flash',
    'glm-5.3-flash-free': 'zai/glm-5.3-flash',
    'deepseek-v4.1-flash': 'opencode-go/deepseek-v4.1-flash',
    'deepseek-v4.1-flash-free': 'opencode-go/deepseek-v4.1-flash'
};

/** Every models.dev key the price table must contain. */
export function getReferencedPriceKeys(): string[] {
    const keys = new Set<string>(Object.values(NON_CLAUDE_MODEL_ALIASES));
    for (const name of CLAUDE_PRICED_MODELS) {
        keys.add(`anthropic/${name}`);
    }
    return [...keys].sort();
}

/** True for Claude models as the transcript names them, `[1m]` and date suffixes included. */
export function isClaudeModel(model: string): boolean {
    return model.startsWith('claude-');
}

/** Maps a transcript model name to its models.dev key, or null when it has no price. */
export function resolvePriceKey(model: string): string | null {
    const direct = NON_CLAUDE_MODEL_ALIASES[model];
    if (direct !== undefined) {
        return direct;
    }
    if (!isClaudeModel(model)) {
        return null;
    }
    const normalized = model.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
    return (CLAUDE_PRICED_MODELS as readonly string[]).includes(normalized)
        ? `anthropic/${normalized}`
        : null;
}
