import * as fs from 'fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import {
    getCompactBoundaryPostTokens,
    isCompactBoundary
} from './compaction';
import { parseJsonlLine } from './jsonl-lines';
import type { ResolvedThinkingEffort } from './jsonl-metadata';
import { extractThinkingEffortMarker } from './jsonl-metadata';
import { extractPlainUserPromptFromRecord } from './last-prompt';

/**
 * Slim, cache-friendly projection of a transcript line. Only the fields the
 * metrics aggregators consume are kept, so an 80MB transcript reduces to a
 * few MB of entries that can be persisted and reused across renders.
 */
export interface SlimTranscriptEntry {
    /** Timestamp in epoch ms (omitted when missing or unparsable) */
    t?: number;
    /** Line type, kept only for 'user' / 'assistant' */
    y?: 'user' | 'assistant';
    /** 1 when isSidechain === true */
    s?: 1;
    /** 1 when isApiErrorMessage is truthy */
    e?: 1;
    /**
     * stop_reason encoding: absent = field missing, 0 = null,
     * 1 = truthy string, 2 = present but other falsy value
     */
    r?: 0 | 1 | 2;
    /** usage: [input, output, cacheRead, cacheCreation] */
    u?: [number, number, number, number];
    /** 1 when this row is a { type:'system', subtype:'compact_boundary' } record */
    c?: 1;
    /** compactMetadata.postTokens of a boundary row, when the record reports it */
    p?: number;
}

export interface TranscriptData {
    entries: SlimTranscriptEntry[];
    agentIds: Set<string>;
    /** Last plain user prompt seen in the transcript (truncated) */
    lastPrompt: string | null;
    /** Effort set by the latest /model or /effort marker, if any */
    thinkingEffort: ResolvedThinkingEffort | undefined;
}

/**
 * True when the newest main-chain transcript row is still a user turn
 * (prompt or tool result) with no assistant reply after it — i.e. a model
 * call is in flight. Mirrors CacheTimer's "HOT" detection without a second
 * file read; callers pass entries already loaded via readTranscriptData.
 */
export function isTranscriptTurnInFlight(entries: SlimTranscriptEntry[]): boolean {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!entry || entry.s === 1) {
            continue;
        }
        if (entry.y === 'assistant') {
            return false;
        }
        if (entry.y === 'user') {
            return true;
        }
    }
    return false;
}

interface TranscriptCacheFile {
    v: number;
    path: string;
    /** Byte offset of fully-parsed content (always ends right after a newline) */
    offset: number;
    /** SHA-256 of the first headLen bytes, to detect rewritten files */
    head: string;
    headLen: number;
    entries: SlimTranscriptEntry[];
    agentIds: string[];
    lastPrompt: string | null;
    effort: ResolvedThinkingEffort | null;
}

const CACHE_VERSION = 4;
const MAX_CACHED_PROMPT_LENGTH = 500;
const HEAD_SAMPLE_BYTES = 4096;
const MAX_CACHE_FILES = 512;

const processMemo = new Map<string, TranscriptData>();

function getCacheDir(): string {
    return path.join(os.homedir(), '.cache', 'ccstatusline', 'transcripts');
}

function getCacheFilePath(transcriptPath: string): string {
    const hash = createHash('sha256')
        .update(path.resolve(transcriptPath))
        .digest('hex')
        .slice(0, 16);
    return path.join(getCacheDir(), `transcript-${hash}.json`);
}

function hashBuffer(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
}

function collectAgentIds(value: unknown, agentIds: Set<string>) {
    if (!value || typeof value !== 'object') {
        return;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectAgentIds(item, agentIds);
        }
        return;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
        if (key === 'agentId' && typeof nestedValue === 'string' && nestedValue.trim() !== '') {
            agentIds.add(nestedValue);
            continue;
        }

        collectAgentIds(nestedValue, agentIds);
    }
}

interface RawTranscriptLine {
    timestamp?: string;
    type?: string;
    isSidechain?: boolean;
    isApiErrorMessage?: boolean;
    message?: {
        content?: unknown;
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
        };
        stop_reason?: string | null;
    };
}

interface SlimifySink {
    agentIds: Set<string>;
    lastPrompt: string | null;
    /** Latest effort marker: undefined = none seen, otherwise its level */
    effortMarker?: { level: ResolvedThinkingEffort | undefined };
}

function slimifyLine(line: string, sink: SlimifySink): SlimTranscriptEntry | null {
    // Cheap pre-filter: only lines mentioning agentId need the deep recursive
    // scan for referenced subagents.
    const needsAgentScan = line.includes('"agentId"');
    const needsBoundaryScan = line.includes('"compact_boundary"');
    if (!needsAgentScan && !needsBoundaryScan && !line.includes('"timestamp"') && !line.includes('"usage"')) {
        return null;
    }

    const data = parseJsonlLine(line) as RawTranscriptLine | null;
    if (!data || typeof data !== 'object') {
        return null;
    }

    if (needsAgentScan) {
        collectAgentIds(data, sink.agentIds);
    }

    if (data.type === 'user') {
        const prompt = extractPlainUserPromptFromRecord(data);
        if (prompt !== null) {
            sink.lastPrompt = prompt.slice(0, MAX_CACHED_PROMPT_LENGTH);
        }
    }

    const markerContent = data.message?.content;
    if (typeof markerContent === 'string' && markerContent.includes('<local-command-stdout>Set ')) {
        const marker = extractThinkingEffortMarker(markerContent);
        if (marker) {
            sink.effortMarker = marker;
        }
    }

    const entry: SlimTranscriptEntry = {};

    if (data.timestamp) {
        const ts = new Date(data.timestamp).getTime();
        if (!Number.isNaN(ts)) {
            entry.t = ts;
        }
    }

    if (data.type === 'user' || data.type === 'assistant') {
        entry.y = data.type;
    }

    if (data.isSidechain === true) {
        entry.s = 1;
    }

    if (data.isApiErrorMessage) {
        entry.e = 1;
    }

    if (isCompactBoundary(data)) {
        entry.c = 1;
        const postTokens = getCompactBoundaryPostTokens(data);
        if (postTokens !== null) {
            entry.p = postTokens;
        }
    }

    const message = data.message;
    if (message && typeof message === 'object') {
        const usage = message.usage;
        if (usage && typeof usage === 'object') {
            entry.u = [
                usage.input_tokens ?? 0,
                usage.output_tokens ?? 0,
                usage.cache_read_input_tokens ?? 0,
                usage.cache_creation_input_tokens ?? 0
            ];

            if (Object.hasOwn(message, 'stop_reason')) {
                const stopReason = message.stop_reason;
                entry.r = stopReason === null ? 0 : (stopReason ? 1 : 2);
            }
        }
    }

    if (entry.t === undefined && entry.u === undefined && entry.y === undefined && entry.c === undefined) {
        return null;
    }

    return entry;
}

interface ParsedChunk {
    entries: SlimTranscriptEntry[];
    agentIds: Set<string>;
    lastPrompt: string | null;
    effortMarker?: { level: ResolvedThinkingEffort | undefined };
    /** Byte length of the fully-terminated portion of the chunk */
    completeBytes: number;
    /** Trailing partial line (no newline yet), parsed but not cacheable */
    tailEntries: SlimTranscriptEntry[];
    tailAgentIds: Set<string>;
    tailLastPrompt: string | null;
    tailEffortMarker?: { level: ResolvedThinkingEffort | undefined };
}

function parseChunk(buffer: Buffer): ParsedChunk {
    const lastNewline = buffer.lastIndexOf(0x0A);
    const completeBytes = lastNewline === -1 ? 0 : lastNewline + 1;

    const entries: SlimTranscriptEntry[] = [];
    const sink: SlimifySink = { agentIds: new Set<string>(), lastPrompt: null };
    if (completeBytes > 0) {
        for (const line of buffer.toString('utf-8', 0, completeBytes).split('\n')) {
            if (line.length === 0) {
                continue;
            }
            const entry = slimifyLine(line, sink);
            if (entry) {
                entries.push(entry);
            }
        }
    }

    const tailEntries: SlimTranscriptEntry[] = [];
    const tailSink: SlimifySink = { agentIds: new Set<string>(), lastPrompt: null };
    if (completeBytes < buffer.length) {
        const tailLine = buffer.toString('utf-8', completeBytes).trim();
        if (tailLine.length > 0) {
            const entry = slimifyLine(tailLine, tailSink);
            if (entry) {
                tailEntries.push(entry);
            }
        }
    }

    return {
        entries,
        agentIds: sink.agentIds,
        lastPrompt: sink.lastPrompt,
        effortMarker: sink.effortMarker,
        completeBytes,
        tailEntries,
        tailAgentIds: tailSink.agentIds,
        tailLastPrompt: tailSink.lastPrompt,
        tailEffortMarker: tailSink.effortMarker
    };
}

function readCacheFile(transcriptPath: string): TranscriptCacheFile | null {
    try {
        const content = fs.readFileSync(getCacheFilePath(transcriptPath), 'utf-8');
        const cache = JSON.parse(content) as TranscriptCacheFile;
        if (
            cache.v !== CACHE_VERSION
            || cache.path !== path.resolve(transcriptPath)
            || typeof cache.offset !== 'number'
            || typeof cache.head !== 'string'
            || typeof cache.headLen !== 'number'
            || !Array.isArray(cache.entries)
            || !Array.isArray(cache.agentIds)
            || (cache.lastPrompt !== null && typeof cache.lastPrompt !== 'string')
            || (cache.effort !== null && typeof cache.effort.value !== 'string')
        ) {
            return null;
        }
        return cache;
    } catch {
        return null;
    }
}

function pruneCacheDir(cacheDir: string) {
    try {
        const files = fs.readdirSync(cacheDir)
            .filter(name => name.endsWith('.json'));
        if (files.length <= MAX_CACHE_FILES) {
            return;
        }
        const withMtime = files.map((name) => {
            const fullPath = path.join(cacheDir, name);
            return { fullPath, mtime: fs.statSync(fullPath).mtimeMs };
        });
        withMtime.sort((a, b) => a.mtime - b.mtime);
        for (const stale of withMtime.slice(0, withMtime.length - MAX_CACHE_FILES)) {
            fs.rmSync(stale.fullPath, { force: true });
        }
    } catch {
        // Best-effort cleanup
    }
}

function writeCacheFile(transcriptPath: string, cache: TranscriptCacheFile) {
    try {
        const cacheDir = getCacheDir();
        fs.mkdirSync(cacheDir, { recursive: true });
        const cachePath = getCacheFilePath(transcriptPath);
        const tmpPath = `${cachePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(cache), 'utf-8');
        fs.renameSync(tmpPath, cachePath);
        pruneCacheDir(cacheDir);
    } catch {
        // Caching is best-effort; rendering proceeds without it
    }
}

async function readBytes(fd: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
        const { bytesRead } = await fd.read(buffer, read, length - read, position + read);
        if (bytesRead === 0) {
            break;
        }
        read += bytesRead;
    }
    return read === length ? buffer : buffer.subarray(0, read);
}

/**
 * Reads a transcript with incremental caching: previously parsed content is
 * restored from a persistent cache keyed by path, and only bytes appended
 * since the last render are read and parsed. Results are also memoized per
 * process so multiple widgets share a single read.
 */
export async function readTranscriptData(transcriptPath: string): Promise<TranscriptData> {
    const memoized = processMemo.get(transcriptPath);
    if (memoized) {
        return memoized;
    }

    const fd = await fs.promises.open(transcriptPath, 'r');
    try {
        const fileSize = (await fd.stat()).size;
        const cache = readCacheFile(transcriptPath);

        let baseEntries: SlimTranscriptEntry[] = [];
        let baseAgentIds = new Set<string>();
        let baseLastPrompt: string | null = null;
        let baseEffort: ResolvedThinkingEffort | undefined;
        let baseOffset = 0;
        let head = '';
        let headLen = 0;

        if (cache && cache.offset <= fileSize && cache.headLen <= fileSize) {
            const headBuffer = await readBytes(fd, 0, cache.headLen);
            if (headBuffer.length === cache.headLen && hashBuffer(headBuffer) === cache.head) {
                baseEntries = cache.entries;
                baseAgentIds = new Set(cache.agentIds);
                baseLastPrompt = cache.lastPrompt;
                baseEffort = cache.effort ?? undefined;
                baseOffset = cache.offset;
                head = cache.head;
                headLen = cache.headLen;
            }
        }

        if (headLen === 0 && fileSize > 0) {
            const sampleLen = Math.min(HEAD_SAMPLE_BYTES, fileSize);
            head = hashBuffer(await readBytes(fd, 0, sampleLen));
            headLen = sampleLen;
        }

        let result: TranscriptData;
        if (fileSize > baseOffset) {
            const chunk = parseChunk(await readBytes(fd, baseOffset, fileSize - baseOffset));
            const cachedEntries = [...baseEntries, ...chunk.entries];
            const cachedAgentIds = new Set(baseAgentIds);
            for (const id of chunk.agentIds) {
                cachedAgentIds.add(id);
            }
            const cachedLastPrompt = chunk.lastPrompt ?? baseLastPrompt;
            const cachedEffort = chunk.effortMarker ? chunk.effortMarker.level : baseEffort;

            const newOffset = baseOffset + chunk.completeBytes;
            if (newOffset > baseOffset || !cache) {
                writeCacheFile(transcriptPath, {
                    v: CACHE_VERSION,
                    path: path.resolve(transcriptPath),
                    offset: newOffset,
                    head,
                    headLen,
                    entries: cachedEntries,
                    agentIds: Array.from(cachedAgentIds),
                    lastPrompt: cachedLastPrompt,
                    effort: cachedEffort ?? null
                });
            }

            const agentIds = new Set(cachedAgentIds);
            for (const id of chunk.tailAgentIds) {
                agentIds.add(id);
            }
            result = {
                entries: [...cachedEntries, ...chunk.tailEntries],
                agentIds,
                lastPrompt: chunk.tailLastPrompt ?? cachedLastPrompt,
                thinkingEffort: chunk.tailEffortMarker ? chunk.tailEffortMarker.level : cachedEffort
            };
        } else {
            result = {
                entries: baseEntries,
                agentIds: baseAgentIds,
                lastPrompt: baseLastPrompt,
                thinkingEffort: baseEffort
            };
        }

        processMemo.set(transcriptPath, result);
        return result;
    } finally {
        await fd.close();
    }
}

/** Clears the per-process memo (used by tests) */
export function clearTranscriptMemo() {
    processMemo.clear();
}

/**
 * Small auxiliary JSON cache in the transcripts cache directory, keyed by a
 * prefix plus the (hashed) path it belongs to. Used for derived aggregates
 * such as per-subagent speed metrics.
 */
export function readAuxCache(prefix: string, keyPath: string): unknown {
    try {
        const hash = createHash('sha256')
            .update(path.resolve(keyPath))
            .digest('hex')
            .slice(0, 16);
        const content = fs.readFileSync(path.join(getCacheDir(), `${prefix}-${hash}.json`), 'utf-8');
        return JSON.parse(content) as unknown;
    } catch {
        return null;
    }
}

export function writeAuxCache(prefix: string, keyPath: string, value: unknown): void {
    try {
        const cacheDir = getCacheDir();
        fs.mkdirSync(cacheDir, { recursive: true });
        const hash = createHash('sha256')
            .update(path.resolve(keyPath))
            .digest('hex')
            .slice(0, 16);
        const cachePath = path.join(cacheDir, `${prefix}-${hash}.json`);
        const tmpPath = `${cachePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(value), 'utf-8');
        fs.renameSync(tmpPath, cachePath);
    } catch {
        // Caching is best-effort
    }
}
