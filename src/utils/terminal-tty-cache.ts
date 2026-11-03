import {
    readCachedTTY,
    writeCachedWidth
} from './terminal-width-cache';

interface AncestorTTY { ancestorPid: number; tty: string }

export function readAncestorTTY(sessionId: string, ttlSeconds: number): AncestorTTY | null {
    const value = readCachedTTY(sessionId, ttlSeconds);
    if (!value)
        return null;
    try {
        process.kill(value.ancestorPid, 0);
        return value;
    } catch {
        return null;
    }
}

export function writeAncestorTTY(sessionId: string, value: AncestorTTY): void {
    writeCachedWidth(sessionId, null, undefined, value);
}
