import {
    iterateJsonlLinesReverseSync,
    parseJsonlLine
} from './jsonl-lines';

// Newest-first scan stops at the first main-thread assistant message; the cap
// only bounds the walk through sidechain / non-assistant lines.
const MAX_LINES_SCANNED = 400;

// Unlike the newest-first assistant lookup, the last model attachment can sit far back
// in a long session, so the walk is longer and skips JSON parsing for other lines.
const MAX_ATTACHMENT_LINES_SCANNED = 20000;
const MODEL_ATTACHMENT_MARKER = '"type":"model"';

interface TranscriptRecord {
    isSidechain?: boolean;
    message?: { model?: unknown };
    attachment?: { type?: string; identity?: { modelId?: unknown } };
}

/** Strips `[1m]`-style suffixes and a trailing `-YYYYMMDD` date so ids compare by model family and version. */
export function normalizeModelId(id: string): string {
    return id
        .replace(/\[[^\]]*\]/g, '')
        .replace(/-\d{8}$/, '')
        .trim()
        .toLowerCase();
}

/** Model the API actually returned for the latest main-thread assistant message, or undefined. */
export function getLatestReturnedModel(transcriptPath: string | undefined): string | undefined {
    if (!transcriptPath) {
        return undefined;
    }

    try {
        let scanned = 0;
        for (const line of iterateJsonlLinesReverseSync(transcriptPath)) {
            if (++scanned > MAX_LINES_SCANNED) {
                return undefined;
            }
            const record = parseJsonlLine(line) as TranscriptRecord | null;
            if (!record || record.isSidechain === true) {
                continue;
            }
            const model = record.message?.model;
            if (typeof model === 'string' && model !== '<synthetic>' && model.length > 0) {
                return model;
            }
        }
    } catch {
        return undefined;
    }

    return undefined;
}

/** Model the latest request asked for, from the model attachment Claude Code writes when the model changes, or undefined. */
export function getLastRequestedModel(transcriptPath: string | undefined): string | undefined {
    if (!transcriptPath) {
        return undefined;
    }

    try {
        let scanned = 0;
        for (const line of iterateJsonlLinesReverseSync(transcriptPath)) {
            if (++scanned > MAX_ATTACHMENT_LINES_SCANNED) {
                return undefined;
            }
            if (!line.includes(MODEL_ATTACHMENT_MARKER)) {
                continue;
            }
            const record = parseJsonlLine(line) as TranscriptRecord | null;
            if (!record || record.isSidechain === true || record.attachment?.type !== 'model') {
                continue;
            }
            const modelId = record.attachment.identity?.modelId;
            if (typeof modelId === 'string' && modelId.length > 0) {
                return modelId;
            }
        }
    } catch {
        return undefined;
    }

    return undefined;
}

/** True when both ids name the same request target; Claude Code reports a routing group as `group/<name>` in the status line. */
export function isSameRequestedModel(left: string, right: string): boolean {
    const bare = (id: string): string => normalizeModelId(id.replace(/^group\//i, ''));
    return bare(left) === bare(right);
}

/**
 * Returns the model the server answered with when it differs from the
 * requested Claude model, otherwise null. Non-Claude and alias ids never mismatch.
 */
export function detectModelMismatch(requestedId: string | undefined, transcriptPath: string | undefined): string | null {
    if (!requestedId || !/^claude-/i.test(requestedId)) {
        return null;
    }

    const returned = getLatestReturnedModel(transcriptPath);
    if (!returned || !/^claude-/i.test(returned)) {
        return null;
    }

    return normalizeModelId(returned) === normalizeModelId(requestedId) ? null : returned;
}

/** `claude-sonnet-5-5` -> `Sonnet 5.5`, `claude-3-5-haiku-20241022` -> `Haiku 3.5`; unknown shapes fall back to the id. */
export function formatClaudeModelId(id: string): string {
    const slug = normalizeModelId(id).replace(/^claude-/, '');
    const family = /^(opus|sonnet|haiku|fable)(?:-(\d+(?:-\d+)?))?$/.exec(slug);
    if (family?.[1]) {
        const name = family[1].charAt(0).toUpperCase() + family[1].slice(1);
        return family[2] ? `${name} ${family[2].replace('-', '.')}` : name;
    }

    const legacy = /^(\d+(?:-\d+)?)-(opus|sonnet|haiku)$/.exec(slug);
    if (legacy?.[1] && legacy[2]) {
        return `${legacy[2].charAt(0).toUpperCase()}${legacy[2].slice(1)} ${legacy[1].replace('-', '.')}`;
    }

    return id;
}
