import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import modelPrices from '../data/model-prices.json';

import {
    isClaudeModel,
    resolvePriceKey
} from './model-price-aliases';

interface PriceTier {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    tier: { size: number };
}

interface ModelPrice {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    tiers?: PriceTier[];
}

/** Token totals of one price tier: input, output, cache read, 5m cache write, 1h cache write. */
type TierTokens = [number, number, number, number, number];

/** Per model, tokens by price tier; index 0 is the base price, index n the n-th `tiers` entry. */
type ModelTokens = Record<string, Record<number, TierTokens>>;

interface FileState {
    ino: number;
    /** Bytes consumed so far, always ending just after a newline. */
    offset: number;
    ids: string[];
    models: ModelTokens;
}

interface CostCache {
    priceVersion: string;
    files: Record<string, FileState>;
}

export interface SessionCostSummary {
    /** Sum of every priced message at its own model's API price, in USD. */
    total: number;
    /** True when every message came from a Claude model. */
    allClaude: boolean;
    /** True when some message's model has no known price, so `total` leaves it out. */
    hasUnknown: boolean;
}

const PRICES = modelPrices as Record<string, ModelPrice>;
const PRICE_VERSION = createHash('sha256').update(JSON.stringify(PRICES)).digest('hex').slice(0, 12);
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

function getCachePath(transcriptPath: string): string {
    const hash = createHash('sha256').update(path.resolve(transcriptPath)).digest('hex').slice(0, 16);
    return path.join(os.homedir(), '.cache', 'ccstatusline', `session-cost-${hash}.json`);
}

function loadCache(cachePath: string): CostCache {
    try {
        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as CostCache;
        if (cache.priceVersion === PRICE_VERSION && typeof cache.files === 'object') {
            return cache;
        }
    } catch {
        // Missing or corrupt cache: start over
    }
    return { priceVersion: PRICE_VERSION, files: {} };
}

function saveCache(cachePath: string, cache: CostCache): void {
    try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        const tmpPath = `${cachePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(cache), 'utf-8');
        fs.renameSync(tmpPath, cachePath);
    } catch {
        // Best-effort: the next render recomputes
    }
}

function getSubagentFiles(transcriptPath: string): string[] {
    const dir = path.join(
        path.dirname(transcriptPath),
        path.basename(transcriptPath, '.jsonl'),
        'subagents'
    );
    try {
        return fs.readdirSync(dir)
            .filter(name => name.startsWith('agent-') && name.endsWith('.jsonl'))
            .sort()
            .map(name => path.join(dir, name));
    } catch {
        return [];
    }
}

interface UsageLine {
    message?: {
        id?: string;
        model?: string;
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_creation?: {
                ephemeral_5m_input_tokens?: number;
                ephemeral_1h_input_tokens?: number;
            };
        };
    };
}

function pickTier(model: string, promptTokens: number): number {
    const key = resolvePriceKey(model);
    const tiers = key === null ? undefined : PRICES[key]?.tiers;
    let picked = 0;
    tiers?.forEach((tier, index) => {
        if (promptTokens > tier.tier.size) {
            picked = index + 1;
        }
    });
    return picked;
}

function addLine(state: FileState, seen: Set<string>, line: string): void {
    if (!line.includes('"usage"')) {
        return;
    }

    let parsed: UsageLine;
    try {
        parsed = JSON.parse(line) as UsageLine;
    } catch {
        return;
    }

    const message = parsed.message;
    const usage = message?.usage;
    const model = message?.model;
    if (!usage || typeof model !== 'string' || model === '<synthetic>') {
        return;
    }

    // Claude Code writes one line per content block, all carrying the same usage
    const id = message.id;
    if (id !== undefined) {
        if (seen.has(id)) {
            return;
        }
        seen.add(id);
        state.ids.push(id);
    }

    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreated = usage.cache_creation_input_tokens ?? 0;
    if (input + output + cacheRead + cacheCreated === 0) {
        return;
    }

    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(cacheCreated - write1h, 0);

    const tier = pickTier(model, input + cacheRead + cacheCreated);
    const byTier = state.models[model] ??= {};
    const tokens = byTier[tier] ??= [0, 0, 0, 0, 0];
    tokens[0] += input;
    tokens[1] += output;
    tokens[2] += cacheRead;
    tokens[3] += write5m;
    tokens[4] += write1h;
}

/** Reads bytes appended since `state.offset`, feeding each complete line to `addLine`. */
function consumeAppended(filePath: string, size: number, state: FileState): void {
    const fd = fs.openSync(filePath, 'r');
    try {
        const seen = new Set(state.ids);
        let position = state.offset;
        let carry = Buffer.alloc(0);
        let consumed = state.offset;

        while (position < size) {
            const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - position));
            const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, position);
            if (bytesRead === 0) {
                break;
            }
            position += bytesRead;

            let buffer = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
            const lastNewline = buffer.lastIndexOf(0x0a);
            if (lastNewline === -1) {
                carry = buffer;
                continue;
            }

            carry = Buffer.from(buffer.subarray(lastNewline + 1));
            buffer = buffer.subarray(0, lastNewline);
            for (const line of buffer.toString('utf-8').split('\n')) {
                addLine(state, seen, line);
            }
            consumed = position - carry.length;
        }

        // A trailing line without newline may still be mid-write, so it waits
        state.offset = consumed;
    } finally {
        fs.closeSync(fd);
    }
}

function refreshFile(filePath: string, previous: FileState | undefined): FileState | null {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch {
        return null;
    }

    const state: FileState = previous?.ino === stat.ino && previous.offset <= stat.size
        ? previous
        : { ino: stat.ino, offset: 0, ids: [], models: {} };

    if (state.offset < stat.size) {
        consumeAppended(filePath, stat.size, state);
    }
    return state;
}

function priceTokens(price: ModelPrice, tierIndex: number, tokens: TierTokens): number {
    const tier = tierIndex > 0 ? price.tiers?.[tierIndex - 1] : undefined;
    const input = tier?.input ?? price.input;
    const output = tier?.output ?? price.output;
    const cacheRead = tier ? (tier.cache_read ?? price.cache_read ?? input) : (price.cache_read ?? input);
    const cacheWrite = tier ? (tier.cache_write ?? price.cache_write ?? input) : (price.cache_write ?? input);

    // Anthropic bills 1h cache writes at twice the input price
    return (
        tokens[0] * input
        + tokens[1] * output
        + tokens[2] * cacheRead
        + tokens[3] * cacheWrite
        + tokens[4] * 2 * input
    ) / 1_000_000;
}

function summarize(files: FileState[]): SessionCostSummary {
    let total = 0;
    let allClaude = true;
    let hasUnknown = false;

    for (const file of files) {
        for (const [model, byTier] of Object.entries(file.models)) {
            if (!isClaudeModel(model)) {
                allClaude = false;
            }
            const key = resolvePriceKey(model);
            const price = key === null ? undefined : PRICES[key];
            if (!price) {
                hasUnknown = true;
                continue;
            }
            for (const [tierIndex, tokens] of Object.entries(byTier)) {
                total += priceTokens(price, Number(tierIndex), tokens);
            }
        }
    }

    return { total, allClaude, hasUnknown };
}

/**
 * Prices a session's main and subagent transcripts, each message at its own model's API price.
 *
 * @remarks
 * Per-file progress persists under `~/.cache/ccstatusline`, so a render reads
 * only the bytes appended since the previous one; transcripts reach tens of MB.
 *
 * @returns null when the transcript cannot be read
 */
export function getSessionCostSummary(transcriptPath: string): SessionCostSummary | null {
    try {
        return readSessionCost(transcriptPath);
    } catch {
        return null;
    }
}

function readSessionCost(transcriptPath: string): SessionCostSummary | null {
    if (!fs.existsSync(transcriptPath)) {
        return null;
    }

    const cachePath = getCachePath(transcriptPath);
    const cache = loadCache(cachePath);
    const nextFiles: Record<string, FileState> = {};
    let changed = false;

    for (const filePath of [transcriptPath, ...getSubagentFiles(transcriptPath)]) {
        const previous = cache.files[filePath];
        const previousOffset = previous?.offset;
        const state = refreshFile(filePath, previous);
        if (state === null) {
            continue;
        }
        nextFiles[filePath] = state;
        if (state.offset !== previousOffset) {
            changed = true;
        }
    }

    if (Object.keys(nextFiles).length !== Object.keys(cache.files).length) {
        changed = true;
    }
    if (changed) {
        saveCache(cachePath, { priceVersion: PRICE_VERSION, files: nextFiles });
    }

    return summarize(Object.values(nextFiles));
}
