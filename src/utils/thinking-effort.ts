import type { ColorLevelString } from '../types/ColorLevel';
import type { RenderContext } from '../types/RenderContext';

import { loadClaudeSettingsSync } from './claude-settings';
import { getColorAnsiCode } from './colors';
import {
    getTranscriptThinkingEffort,
    normalizeThinkingEffort,
    type ResolvedThinkingEffort,
    type TranscriptThinkingEffort
} from './jsonl';

function resolveThinkingEffortFromStatusJson(context: RenderContext): ResolvedThinkingEffort | null | undefined {
    const effort = context.data?.effort;
    if (!effort || !('level' in effort)) {
        return undefined;
    }

    return typeof effort.level === 'string' ? normalizeThinkingEffort(effort.level) : null;
}

function resolveThinkingEffortFromSettings(): ResolvedThinkingEffort | undefined {
    try {
        const settings = loadClaudeSettingsSync({ logErrors: false });
        return normalizeThinkingEffort(settings.effortLevel);
    } catch {
        // Settings unavailable, return undefined
    }

    return undefined;
}

export function resolveThinkingEffort(context: RenderContext): ResolvedThinkingEffort | null {
    const statusEffort = resolveThinkingEffortFromStatusJson(context);
    if (statusEffort !== undefined) {
        return statusEffort;
    }

    // The main render flow pre-computes the transcript effort via the shared
    // transcript cache; null means it was checked and no marker was found.
    if (context.transcriptThinkingEffort !== undefined) {
        return context.transcriptThinkingEffort
            ?? resolveThinkingEffortFromSettings()
            ?? null;
    }

    return getTranscriptThinkingEffort(context.data?.transcript_path)
        ?? resolveThinkingEffortFromSettings()
        ?? null;
}

const ULTRATHINK_PALETTE = [
    'hex:eb5f57', // red
    'hex:f58b57', // orange
    'hex:fac35f', // yellow
    'hex:91c882', // green
    'hex:82aadc', // blue
    'hex:9b82c8', // indigo
    'hex:c882b4' // violet
];

const EFFORT_COLORS: Record<Exclude<TranscriptThinkingEffort, 'max'>, string> = {
    low: 'hex:ffc107', // gold (matches Claude Code "warning")
    medium: 'hex:4eba65', // green (matches Claude Code "success")
    high: 'hex:b1b9f9', // lavender (matches Claude Code "permission")
    xhigh: 'hex:af87ff' // purple (matches Claude Code "autoAccept")
};

const MAX_RAINBOW_PALETTE = ULTRATHINK_PALETTE;

const RESET = '\x1b[0m';

function colorizeRainbow(name: string, colorLevel: ColorLevelString): string {
    let out = '';
    let colorIndex = 0;
    for (const ch of name) {
        if (ch === ' ') {
            out += ch;
            continue;
        }
        const color = MAX_RAINBOW_PALETTE[colorIndex % MAX_RAINBOW_PALETTE.length];
        out += `${getColorAnsiCode(color, colorLevel, false)}${ch}`;
        colorIndex++;
    }
    return `${out}${RESET}`;
}

// Wrap a model name in inline ANSI codes that encode the thinking effort level.
// Returns null when the effort is unknown/unresolved so the caller can fall back
// to the widget's normal (configured) color.
export function colorizeModelName(
    name: string,
    resolved: ResolvedThinkingEffort | null,
    colorLevel: ColorLevelString
): string | null {
    if (!resolved?.known) {
        return null;
    }

    const level = resolved.value as TranscriptThinkingEffort;
    if (level === 'max') {
        return colorizeRainbow(name, colorLevel);
    }

    const code = getColorAnsiCode(EFFORT_COLORS[level], colorLevel, false);
    if (!code) {
        return null;
    }

    return `${code}${name}${RESET}`;
}
