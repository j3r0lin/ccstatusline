import * as fs from 'fs';

const TRANSCRIPT_CHUNK_BYTES = 64 * 1024;

const SKIP_PREFIXES = [
    'Another Claude session sent a message:',
    'This session is being continued from a previous conversation',
    '[Request interrupted by user'
];

interface UserRecord {
    type?: string;
    isSidechain?: boolean;
    isMeta?: boolean;
    origin?: { kind?: string };
    message?: { content?: unknown };
}

export function extractPlainUserPromptFromRecord(d: unknown): string | null {
    const rec = d as UserRecord | null;
    if (rec?.type !== 'user')
        return null;
    if (rec.isSidechain === true || rec.isMeta === true)
        return null;
    if (rec.origin && rec.origin.kind !== 'human')
        return null;

    const c = rec.message?.content;
    let text: string;
    if (typeof c === 'string') {
        text = c;
    } else if (Array.isArray(c)) {
        // Prompts with pasted images arrive as an array of blocks; keep the text ones.
        text = (c as { type?: string; text?: unknown }[])
            .filter(b => b.type === 'text' && typeof b.text === 'string')
            .map(b => b.text as string)
            .join(' ')
            .trim();
        if (!text)
            return null;
    } else {
        return null;
    }

    if (SKIP_PREFIXES.some(p => text.startsWith(p)))
        return null;
    if (!text.startsWith('<'))
        return text;

    const cmdName = /<command-name>(\/[^<]+)<\/command-name>/.exec(text);
    if (cmdName?.[1]) {
        const args = /<command-args>([^<]+)<\/command-args>/.exec(text);
        return args?.[1] ? `${cmdName[1]} ${args[1].trim()}` : cmdName[1];
    }

    return null;
}

function extractPlainUserPrompt(line: string): string | null {
    if (!line)
        return null;
    let d: unknown;
    try {
        d = JSON.parse(line);
    } catch {
        return null;
    }
    return extractPlainUserPromptFromRecord(d);
}

export function readLastPromptFromTranscript(transcriptPath: string): string | null {
    let fd: number;
    try {
        fd = fs.openSync(transcriptPath, 'r');
    } catch {
        return null;
    }
    try {
        const size = fs.fstatSync(fd).size;
        let pos = size;
        let tail: Buffer = Buffer.alloc(0);
        while (pos > 0) {
            const readSize = Math.min(TRANSCRIPT_CHUNK_BYTES, pos);
            pos -= readSize;
            const buf = Buffer.alloc(readSize);
            fs.readSync(fd, buf, 0, readSize, pos);
            // Concatenate bytes (not strings) so multi-byte UTF-8 chars that
            // straddle the chunk boundary are not corrupted by toString.
            const combined = Buffer.concat([buf, tail]);

            let scan: Buffer;
            if (pos === 0) {
                scan = combined;
                tail = Buffer.alloc(0);
            } else {
                const nlIdx = combined.indexOf(0x0a);
                if (nlIdx < 0) {
                    // Whole chunk is one truncated line; carry it forward.
                    tail = combined;
                    continue;
                }
                tail = combined.subarray(0, nlIdx);
                scan = combined.subarray(nlIdx + 1);
            }

            const lines = scan.toString('utf-8').split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                const found = extractPlainUserPrompt(lines[i] ?? '');
                if (found !== null)
                    return found;
            }
        }
        return null;
    } finally {
        fs.closeSync(fd);
    }
}
