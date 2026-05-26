import * as fs from 'fs';

const TRANSCRIPT_CHUNK_BYTES = 64 * 1024;

function extractPlainUserPrompt(line: string): string | null {
    if (!line)
        return null;
    let d: unknown;
    try {
        d = JSON.parse(line);
    } catch {
        return null;
    }
    const rec = d as { type?: string; message?: { content?: unknown } };
    if (rec.type !== 'user')
        return null;
    const c = rec.message?.content;
    if (typeof c !== 'string')
        return null;
    if (!c.startsWith('<'))
        return c;

    const cmdName = c.match(/<command-name>(\/[^<]+)<\/command-name>/);
    if (cmdName) {
        const args = c.match(/<command-args>([^<]+)<\/command-args>/);
        return args ? `${cmdName[1]} ${args[1].trim()}` : cmdName[1];
    }

    return null;
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
