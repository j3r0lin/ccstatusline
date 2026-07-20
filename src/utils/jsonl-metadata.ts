import * as fs from 'fs';

import { getVisibleText } from './ansi';
import { parseJsonlLine } from './jsonl-lines';

const KNOWN_THINKING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const KNOWN_THINKING_EFFORTS_SET: ReadonlySet<string> = new Set(KNOWN_THINKING_EFFORTS);
export type TranscriptThinkingEffort = typeof KNOWN_THINKING_EFFORTS[number];

export interface ResolvedThinkingEffort {
    value: string;
    known: boolean;
}

const MODEL_STDOUT_PREFIX = '<local-command-stdout>Set model to ';
const MODEL_STDOUT_EFFORT_REGEX = /^<local-command-stdout>Set model to[\s\S]*? with ([a-zA-Z0-9-]+) effort<\/local-command-stdout>$/i;
const EFFORT_STDOUT_PREFIX = '<local-command-stdout>Set effort level to ';
const EFFORT_STDOUT_REGEX = /^<local-command-stdout>Set effort level to ([a-zA-Z0-9-]+)\b/i;
const UNKNOWN_EFFORT_PATTERN = /^(?=.*[a-z0-9])[a-z0-9-]{2,20}$/;

interface TranscriptEntry { message?: { content?: string } }

/**
 * Detects a `/model` or `/effort` local-command-stdout marker in a message
 * content string. Returns null when the line is not a marker; otherwise the
 * (possibly undefined) effort it sets.
 */
export function extractThinkingEffortMarker(content: string): { level: ResolvedThinkingEffort | undefined } | null {
    const visibleContent = getVisibleText(content).trim();

    if (visibleContent.startsWith(EFFORT_STDOUT_PREFIX)) {
        const effortMatch = EFFORT_STDOUT_REGEX.exec(visibleContent);
        return effortMatch ? { level: normalizeThinkingEffort(effortMatch[1]) } : null;
    }

    if (!visibleContent.startsWith(MODEL_STDOUT_PREFIX)) {
        return null;
    }

    const match = MODEL_STDOUT_EFFORT_REGEX.exec(visibleContent);
    return { level: normalizeThinkingEffort(match?.[1]) };
}

export function normalizeThinkingEffort(value: string | undefined): ResolvedThinkingEffort | undefined {
    if (!value) {
        return undefined;
    }

    const normalized = value.toLowerCase();
    if (KNOWN_THINKING_EFFORTS_SET.has(normalized)) {
        return { value: normalized, known: true };
    }

    if (UNKNOWN_EFFORT_PATTERN.test(normalized)) {
        return { value: normalized, known: false };
    }

    return undefined;
}

const REVERSE_CHUNK_SIZE = 64 * 1024;
const MARKER_LINE_HINT = 'local-command-stdout';

function extractMarkerFromLine(line: string): { level: ResolvedThinkingEffort | undefined } | null {
    // Cheap pre-filter: marker lines always contain the stdout tag verbatim,
    // so skip JSON parsing for everything else.
    if (!line.includes(MARKER_LINE_HINT)) {
        return null;
    }

    const entry = parseJsonlLine(line) as TranscriptEntry | null;
    if (typeof entry?.message?.content !== 'string') {
        return null;
    }

    return extractThinkingEffortMarker(entry.message.content);
}

export function getTranscriptThinkingEffort(transcriptPath: string | undefined): ResolvedThinkingEffort | undefined {
    if (!transcriptPath) {
        return undefined;
    }

    // Scans the transcript backwards in fixed-size chunks so only the tail of
    // the file (up to the latest marker) is read, instead of loading the whole
    // file into memory.
    let fd: number | undefined;
    try {
        fd = fs.openSync(transcriptPath, 'r');
        const fileSize = fs.fstatSync(fd).size;

        // Bytes preceding the earliest fully-seen line; lines are only decoded
        // once complete so multi-byte characters never split across chunks.
        let carry: Buffer = Buffer.alloc(0);
        let position = fileSize;

        while (position > 0) {
            const chunkSize = Math.min(REVERSE_CHUNK_SIZE, position);
            position -= chunkSize;
            const chunk = Buffer.alloc(chunkSize);
            fs.readSync(fd, chunk, 0, chunkSize, position);

            const buffer = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
            const firstNewline = buffer.indexOf(0x0A);
            if (firstNewline === -1) {
                carry = buffer;
                continue;
            }

            const lines = buffer.toString('utf-8', firstNewline + 1).split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i];
                if (!line) {
                    continue;
                }
                const marker = extractMarkerFromLine(line);
                if (marker) {
                    return marker.level;
                }
            }

            carry = Buffer.from(buffer.subarray(0, firstNewline));
        }

        if (carry.length > 0) {
            const marker = extractMarkerFromLine(carry.toString('utf-8'));
            if (marker) {
                return marker.level;
            }
        }
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }

    return undefined;
}
