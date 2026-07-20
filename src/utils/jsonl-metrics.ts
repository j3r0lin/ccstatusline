import * as fs from 'fs';
import path from 'node:path';

import type {
    SpeedMetrics,
    TokenMetrics
} from '../types';

import type { SlimTranscriptEntry } from './transcript-cache';
import {
    readAuxCache,
    readTranscriptData,
    writeAuxCache
} from './transcript-cache';

export interface SpeedMetricsOptions {
    includeSubagents?: boolean;
    windowSeconds?: number;
}

interface SpeedMetricsCollectionOptions {
    includeSubagents?: boolean;
    windowSeconds?: number[];
}

export interface SpeedMetricsCollection {
    sessionAverage: SpeedMetrics;
    windowed: Record<string, SpeedMetrics>;
}

interface SpeedInterval {
    startMs: number;
    endMs: number;
}

interface SpeedRequest {
    inputTokens: number;
    outputTokens: number;
    assistantTimestampMs: number | null;
    interval: SpeedInterval | null;
}

interface CollectedSpeedMetrics {
    requests: SpeedRequest[];
    latestTimestampMs: number | null;
}

export async function getSessionDuration(transcriptPath: string): Promise<string | null> {
    try {
        if (!fs.existsSync(transcriptPath)) {
            return null;
        }

        const { entries } = await readTranscriptData(transcriptPath);

        let firstTimestamp: number | null = null;
        let lastTimestamp: number | null = null;

        for (const entry of entries) {
            if (entry.t === undefined) {
                continue;
            }
            firstTimestamp ??= entry.t;
            lastTimestamp = entry.t;
        }

        if (firstTimestamp === null || lastTimestamp === null) {
            return null;
        }

        // Calculate duration in milliseconds
        const durationMs = lastTimestamp - firstTimestamp;

        // Convert to minutes
        const totalMinutes = Math.floor(durationMs / (1000 * 60));

        if (totalMinutes < 1) {
            return '<1m';
        }

        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        if (hours === 0) {
            return `${minutes}m`;
        } else if (minutes === 0) {
            return `${hours}hr`;
        } else {
            return `${hours}hr ${minutes}m`;
        }
    } catch {
        return null;
    }
}

export async function getTokenMetrics(transcriptPath: string): Promise<TokenMetrics> {
    try {
        if (!fs.existsSync(transcriptPath)) {
            return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, contextLength: 0, lastCompletionMs: null };
        }

        const { entries } = await readTranscriptData(transcriptPath);

        let inputTokens = 0;
        let outputTokens = 0;
        let cachedTokens = 0;
        let contextLength = 0;

        // Claude Code writes multiple JSONL entries per API call during streaming:
        // intermediate entries have stop_reason: null, and the final entry has a
        // string value like "end_turn" or "tool_use". For streaming-aware
        // transcripts, count finalized entries plus the latest unfinished entry so
        // live updates do not overcount duplicate partial rows. If the transcript
        // format has no stop_reason field at all, fall back to counting all entries.
        const usageEntries = entries.filter(entry => entry.u);
        const hasStopReasonField = usageEntries.some(entry => entry.r !== undefined);

        const entriesToCount = hasStopReasonField
            ? usageEntries.filter((entry, index) => entry.r === 1 || (entry.r === 0 && index === usageEntries.length - 1))
            : usageEntries;

        let mostRecentMainChainEntry: SlimTranscriptEntry | null = null;
        let mostRecentTimestamp: number | null = null;

        for (const entry of entriesToCount) {
            const usage = entry.u;
            if (!usage) {
                continue;
            }

            inputTokens += usage[0];
            outputTokens += usage[1];
            cachedTokens += usage[2] + usage[3];

            // Track the most recent main-chain entry, skipping API error messages
            // (synthetic messages with 0 tokens)
            if (entry.s !== 1 && entry.t !== undefined && entry.e !== 1) {
                if (mostRecentTimestamp === null || entry.t > mostRecentTimestamp) {
                    mostRecentTimestamp = entry.t;
                    mostRecentMainChainEntry = entry;
                }
            }
        }

        // Calculate context length from the most recent main chain message
        if (mostRecentMainChainEntry?.u) {
            const usage = mostRecentMainChainEntry.u;
            contextLength = usage[0] + usage[2] + usage[3];
        }

        const totalTokens = inputTokens + outputTokens + cachedTokens;

        return { inputTokens, outputTokens, cachedTokens, totalTokens, contextLength, lastCompletionMs: mostRecentTimestamp };
    } catch {
        return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, contextLength: 0, lastCompletionMs: null };
    }
}

function mergeIntervals(intervals: SpeedInterval[]): SpeedInterval[] {
    if (intervals.length === 0) {
        return [];
    }

    const sorted = intervals
        .slice()
        .sort((a, b) => a.startMs - b.startMs);
    const first = sorted[0];
    if (!first) {
        return [];
    }
    const merged: SpeedInterval[] = [{ ...first }];

    for (let i = 1; i < sorted.length; i++) {
        const current = sorted[i];
        const last = merged[merged.length - 1];
        if (!current || !last) {
            continue;
        }

        if (current.startMs <= last.endMs) {
            last.endMs = Math.max(last.endMs, current.endMs);
        } else {
            merged.push({ ...current });
        }
    }

    return merged;
}

function getIntervalsDurationMs(intervals: SpeedInterval[]): number {
    return intervals.reduce((total, interval) => total + (interval.endMs - interval.startMs), 0);
}

function createEmptySpeedMetrics(): SpeedMetrics {
    return {
        totalDurationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        requestCount: 0
    };
}

function normalizeWindowSeconds(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }

    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
}

function collectSpeedMetricsFromEntries(entries: SlimTranscriptEntry[], ignoreSidechain: boolean): CollectedSpeedMetrics {
    const requests: SpeedRequest[] = [];

    let lastUserTimestamp: number | null = null;
    let latestTimestampMs: number | null = null;

    for (const entry of entries) {
        if (entry.e === 1) {
            continue;
        }

        if (ignoreSidechain && entry.s === 1) {
            continue;
        }

        if (entry.t !== undefined && (latestTimestampMs === null || entry.t > latestTimestampMs)) {
            latestTimestampMs = entry.t;
        }

        if (entry.y === 'user' && entry.t !== undefined) {
            lastUserTimestamp = entry.t;
            continue;
        }

        if (entry.y === 'assistant' && entry.u) {
            let interval: SpeedInterval | null = null;
            if (entry.t !== undefined && lastUserTimestamp !== null && entry.t > lastUserTimestamp) {
                interval = { startMs: lastUserTimestamp, endMs: entry.t };
            }

            requests.push({
                inputTokens: entry.u[0],
                outputTokens: entry.u[1],
                assistantTimestampMs: entry.t ?? null,
                interval
            });
        }
    }

    return {
        requests,
        latestTimestampMs
    };
}

function mergeCollectedSpeedMetrics(parts: CollectedSpeedMetrics[]): CollectedSpeedMetrics {
    const requests: SpeedRequest[] = [];
    let latestTimestampMs: number | null = null;

    for (const part of parts) {
        requests.push(...part.requests);

        if (part.latestTimestampMs !== null && (latestTimestampMs === null || part.latestTimestampMs > latestTimestampMs)) {
            latestTimestampMs = part.latestTimestampMs;
        }
    }

    return {
        requests,
        latestTimestampMs
    };
}

function buildSpeedMetrics(
    collected: CollectedSpeedMetrics,
    windowSeconds?: number
): SpeedMetrics {
    const normalizedWindowSeconds = normalizeWindowSeconds(windowSeconds);
    if (normalizedWindowSeconds !== null && collected.latestTimestampMs === null) {
        return createEmptySpeedMetrics();
    }

    const windowEndMs = normalizedWindowSeconds !== null && collected.latestTimestampMs !== null
        ? collected.latestTimestampMs
        : null;
    const windowStartMs = normalizedWindowSeconds !== null && windowEndMs !== null
        ? windowEndMs - (normalizedWindowSeconds * 1000)
        : null;

    const selectedRequests = normalizedWindowSeconds !== null && windowStartMs !== null && windowEndMs !== null
        ? collected.requests.filter(request => request.assistantTimestampMs !== null
            && request.assistantTimestampMs >= windowStartMs
            && request.assistantTimestampMs <= windowEndMs
        )
        : collected.requests;

    let inputTokens = 0;
    let outputTokens = 0;
    const intervals: SpeedInterval[] = [];

    for (const request of selectedRequests) {
        inputTokens += request.inputTokens;
        outputTokens += request.outputTokens;

        if (!request.interval) {
            continue;
        }

        if (windowStartMs === null || windowEndMs === null) {
            intervals.push(request.interval);
            continue;
        }

        const clippedStartMs = Math.max(request.interval.startMs, windowStartMs);
        const clippedEndMs = Math.min(request.interval.endMs, windowEndMs);
        if (clippedEndMs > clippedStartMs) {
            intervals.push({
                startMs: clippedStartMs,
                endMs: clippedEndMs
            });
        }
    }

    const mergedIntervals = mergeIntervals(intervals);
    const totalDurationMs = getIntervalsDurationMs(mergedIntervals);

    return {
        totalDurationMs,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        requestCount: selectedRequests.length
    };
}

function buildEmptyWindowedMetrics(windowSeconds: number[]): Record<string, SpeedMetrics> {
    const windowed: Record<string, SpeedMetrics> = {};
    for (const window of windowSeconds) {
        windowed[window.toString()] = createEmptySpeedMetrics();
    }
    return windowed;
}

function getSubagentTranscriptPaths(transcriptPath: string, referencedAgentIds: Set<string>): string[] {
    if (referencedAgentIds.size === 0) {
        return [];
    }

    const transcriptDir = path.dirname(transcriptPath);
    const transcriptStem = path.parse(transcriptPath).name;
    const candidateDirs = [
        path.join(transcriptDir, 'subagents'),
        path.join(transcriptDir, transcriptStem, 'subagents')
    ];
    const seenPaths = new Set<string>();
    const matchedPaths: string[] = [];

    for (const subagentsDir of candidateDirs) {
        if (!fs.existsSync(subagentsDir)) {
            continue;
        }

        try {
            const dirEntries = fs.readdirSync(subagentsDir, { withFileTypes: true });
            for (const entry of dirEntries) {
                if (!entry.isFile()) {
                    continue;
                }

                const match = /^agent-(.+)\.jsonl$/.exec(entry.name);
                if (!match?.[1]) {
                    continue;
                }

                if (!referencedAgentIds.has(match[1])) {
                    continue;
                }

                const fullPath = path.join(subagentsDir, entry.name);
                if (seenPaths.has(fullPath)) {
                    continue;
                }

                seenPaths.add(fullPath);
                matchedPaths.push(fullPath);
            }
        } catch {
            continue;
        }
    }

    return matchedPaths;
}

interface SubagentSpeedCacheEntry {
    size: number;
    mtimeMs: number;
    collected: CollectedSpeedMetrics;
}

type SubagentSpeedCache = Record<string, SubagentSpeedCacheEntry>;

/**
 * Collects speed metrics for subagent transcripts with an aggregate cache
 * keyed by the main transcript. Finished subagents (unchanged size/mtime)
 * reuse their pre-aggregated result without touching the transcript.
 */
async function collectSubagentSpeedMetrics(
    mainTranscriptPath: string,
    subagentPaths: string[]
): Promise<CollectedSpeedMetrics[]> {
    const cache = (readAuxCache('subagent-speed', mainTranscriptPath) ?? {}) as SubagentSpeedCache;
    const next: SubagentSpeedCache = {};
    const results: CollectedSpeedMetrics[] = [];
    let dirty = false;

    for (const subagentPath of subagentPaths) {
        try {
            const stat = fs.statSync(subagentPath);
            const hit = cache[subagentPath];
            if (
                hit?.size === stat.size
                && hit.mtimeMs === stat.mtimeMs
                && Array.isArray(hit.collected.requests)
            ) {
                next[subagentPath] = hit;
                results.push(hit.collected);
                continue;
            }

            const subagentData = await readTranscriptData(subagentPath);
            const collected = collectSpeedMetricsFromEntries(subagentData.entries, false);
            next[subagentPath] = { size: stat.size, mtimeMs: stat.mtimeMs, collected };
            results.push(collected);
            dirty = true;
        } catch {
            continue;
        }
    }

    if (dirty) {
        writeAuxCache('subagent-speed', mainTranscriptPath, next);
    }

    return results;
}

export async function getSpeedMetricsCollection(
    transcriptPath: string,
    options: SpeedMetricsCollectionOptions = {}
): Promise<SpeedMetricsCollection> {
    const normalizedWindows = Array.from(
        new Set(
            (options.windowSeconds ?? [])
                .map(window => normalizeWindowSeconds(window))
                .filter((window): window is number => window !== null)
        )
    );
    const emptyWindowedMetrics = buildEmptyWindowedMetrics(normalizedWindows);

    try {
        if (!fs.existsSync(transcriptPath)) {
            return {
                sessionAverage: createEmptySpeedMetrics(),
                windowed: emptyWindowedMetrics
            };
        }

        const mainData = await readTranscriptData(transcriptPath);
        const allCollected: CollectedSpeedMetrics[] = [
            collectSpeedMetricsFromEntries(mainData.entries, true)
        ];

        if (options.includeSubagents === true) {
            const subagentPaths = getSubagentTranscriptPaths(transcriptPath, mainData.agentIds);
            if (subagentPaths.length > 0) {
                allCollected.push(...await collectSubagentSpeedMetrics(transcriptPath, subagentPaths));
            }
        }

        const combined = mergeCollectedSpeedMetrics(allCollected);
        const windowed: Record<string, SpeedMetrics> = {};
        for (const window of normalizedWindows) {
            windowed[window.toString()] = buildSpeedMetrics(combined, window);
        }

        return {
            sessionAverage: buildSpeedMetrics(combined),
            windowed
        };
    } catch {
        return {
            sessionAverage: createEmptySpeedMetrics(),
            windowed: emptyWindowedMetrics
        };
    }
}

export async function getSpeedMetrics(
    transcriptPath: string,
    options: SpeedMetricsOptions = {}
): Promise<SpeedMetrics> {
    const requestedWindow = normalizeWindowSeconds(options.windowSeconds);
    const metricsCollection = await getSpeedMetricsCollection(transcriptPath, {
        includeSubagents: options.includeSubagents,
        windowSeconds: requestedWindow ? [requestedWindow] : []
    });

    if (requestedWindow === null) {
        return metricsCollection.sessionAverage;
    }

    return metricsCollection.windowed[requestedWindow.toString()] ?? createEmptySpeedMetrics();
}
