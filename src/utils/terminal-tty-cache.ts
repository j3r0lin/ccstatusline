import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface AncestorTTY { ancestorPid: number; tty: string }

function cachePath(sessionId: string): string {
    const key = createHash('sha256').update(sessionId).digest('hex');
    return path.join(os.homedir(), '.cache', 'ccstatusline', 'terminal-tty', `${key}.json`);
}

export function readAncestorTTY(sessionId: string): AncestorTTY | null {
    try {
        const value = JSON.parse(fs.readFileSync(cachePath(sessionId), 'utf8')) as Partial<AncestorTTY>;
        if (typeof value.ancestorPid !== 'number' || !Number.isSafeInteger(value.ancestorPid) || value.ancestorPid <= 0
            || typeof value.tty !== 'string' || !/^[\w.-]+$/.test(value.tty))
            return null;
        process.kill(value.ancestorPid, 0);
        return { ancestorPid: value.ancestorPid, tty: value.tty };
    } catch {
        return null;
    }
}

export function writeAncestorTTY(sessionId: string, value: AncestorTTY): void {
    const target = cachePath(sessionId);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(value));
        fs.renameSync(tmp, target);
    } catch {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
}
