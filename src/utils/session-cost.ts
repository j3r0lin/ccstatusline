import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
    ModelPrice,
    ModelPrices
} from '../types/ModelPrice';

import {
    isClaudeModel,
    resolvePriceKey
} from './model-price-aliases';
import { getModelPrices } from './model-prices';

/** Token totals billed at one price tier. */
interface TierTokens {
    input: number;
    output: number;
    cacheRead: number;
    write5m: number;
    write1h: number;
}

/** Per model, tokens by price tier; index 0 is the base price, index n the n-th `tiers` entry. */
type ModelTokens = Record<string, Record<number, TierTokens>>;

/** What one message contributed to `models`, kept so a later line for the same id can replace it. */
interface CountedMessage {
    id: string;
    model: string;
    tier: number;
    tokens: TierTokens;
}

interface FileState {
    ino: number;
    /** Bytes consumed so far, always ending just after a newline. */
    offset: number;
    /** Lines sharing a message id are adjacent, so only the latest message needs tracking. */
    last?: CountedMessage;
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

const READ_CHUNK_BYTES = 4 * 1024 * 1024;

function getCachePath(transcriptPath: string): string {
    const hash = createHash('sha256').update(path.resolve(transcriptPath)).digest('hex').slice(0, 16);
    return path.join(os.homedir(), '.cache', 'ccstatusline', `session-cost-${hash}.json`);
}

/** Bump when the cached state's shape changes, so older caches are discarded. */
const CACHE_FORMAT = 2;

/**
 * Cached state stores tokens, not dollars, and the price table is applied on every
 * render, so a changed price needs no recompute. Only the tier boundaries are baked
 * in (each message's tier index), so only they version the cache; this keeps
 * processes holding different price tables from discarding each other's state.
 */
function getPriceVersion(prices: ModelPrices): string {
    const boundaries = Object.keys(prices).sort().flatMap((key) => {
        const tiers = prices[key]?.tiers;
        return tiers ? [[key, tiers.map(t => t.tier.size)]] : [];
    });
    const hash = createHash('sha256').update(JSON.stringify(boundaries)).digest('hex').slice(0, 12);
    return `${CACHE_FORMAT}:${hash}`;
}

function loadCache(cachePath: string, priceVersion: string): CostCache {
    try {
        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as CostCache;
        if (cache.priceVersion === priceVersion && typeof cache.files === 'object') {
            return cache;
        }
    } catch {
        // Missing or corrupt cache: start over
    }
    return { priceVersion, files: {} };
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

function pickTier(prices: ModelPrices, model: string, promptTokens: number): number {
    const key = resolvePriceKey(model);
    const tiers = key === null ? undefined : prices[key]?.tiers;
    let picked = 0;
    tiers?.forEach((tier, index) => {
        if (promptTokens > tier.tier.size) {
            picked = index + 1;
        }
    });
    return picked;
}

function addTokens(state: FileState, message: CountedMessage, sign: 1 | -1): void {
    const byTier = state.models[message.model] ??= {};
    const total = byTier[message.tier] ??= { input: 0, output: 0, cacheRead: 0, write5m: 0, write1h: 0 };
    total.input += sign * message.tokens.input;
    total.output += sign * message.tokens.output;
    total.cacheRead += sign * message.tokens.cacheRead;
    total.write5m += sign * message.tokens.write5m;
    total.write1h += sign * message.tokens.write1h;
}

function addLine(state: FileState, prices: ModelPrices, line: string): void {
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

    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreated = usage.cache_creation_input_tokens ?? 0;
    if (input + output + cacheRead + cacheCreated === 0) {
        return;
    }

    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(cacheCreated - write1h, 0);
    const counted: CountedMessage = {
        id: message.id ?? '',
        model,
        tier: pickTier(prices, model, input + cacheRead + cacheCreated),
        tokens: { input, output, cacheRead, write5m, write1h }
    };

    // Claude Code writes one line per content block, and a later line of the
    // same message carries the settled usage (output grows, input can move
    // into the cache read), so the latest line replaces the earlier one.
    if (counted.id !== '' && state.last?.id === counted.id) {
        addTokens(state, state.last, -1);
    }
    addTokens(state, counted, 1);
    state.last = counted;
}

/** Reads bytes appended since `state.offset`, feeding each complete line to `addLine`. */
function consumeAppended(filePath: string, size: number, state: FileState, prices: ModelPrices): void {
    const fd = fs.openSync(filePath, 'r');
    try {
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
                addLine(state, prices, line);
            }
            consumed = position - carry.length;
        }

        // A trailing line without newline may still be mid-write, so it waits
        state.offset = consumed;
    } finally {
        fs.closeSync(fd);
    }
}

function refreshFile(filePath: string, previous: FileState | undefined, prices: ModelPrices): FileState | null {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch {
        return null;
    }

    const state: FileState = previous?.ino === stat.ino && previous.offset <= stat.size
        ? previous
        : { ino: stat.ino, offset: 0, models: {} };

    if (state.offset < stat.size) {
        consumeAppended(filePath, stat.size, state, prices);
    }
    return state;
}

function priceTokens(price: ModelPrice, tierIndex: number, tokens: TierTokens): number {
    // A tier replaces the base prices whole, so its omissions fall back to its own input price
    const rates = (tierIndex > 0 ? price.tiers?.[tierIndex - 1] : undefined) ?? price;
    const cacheRead = rates.cache_read ?? rates.input;
    const cacheWrite = rates.cache_write ?? rates.input;

    // Anthropic bills 1h cache writes at twice the input price
    return (
        tokens.input * rates.input
        + tokens.output * rates.output
        + tokens.cacheRead * cacheRead
        + tokens.write5m * cacheWrite
        + tokens.write1h * 2 * rates.input
    ) / 1_000_000;
}

function summarize(files: FileState[], prices: ModelPrices): SessionCostSummary {
    let total = 0;
    let allClaude = true;
    let hasUnknown = false;

    for (const file of files) {
        for (const [model, byTier] of Object.entries(file.models)) {
            if (!isClaudeModel(model)) {
                allClaude = false;
            }
            const key = resolvePriceKey(model);
            const price = key === null ? undefined : prices[key];
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
 * @param prices - Price table keyed by models.dev `provider/key`; tests inject a small one
 * @returns null when the transcript cannot be read
 */
export function getSessionCostSummary(transcriptPath: string, prices: ModelPrices = getModelPrices()): SessionCostSummary | null {
    try {
        return readSessionCost(transcriptPath, prices);
    } catch {
        return null;
    }
}

function readSessionCost(transcriptPath: string, prices: ModelPrices): SessionCostSummary | null {
    if (!fs.existsSync(transcriptPath)) {
        return null;
    }

    const cachePath = getCachePath(transcriptPath);
    const priceVersion = getPriceVersion(prices);
    const cache = loadCache(cachePath, priceVersion);
    const nextFiles: Record<string, FileState> = {};
    let changed = false;

    for (const filePath of [transcriptPath, ...getSubagentFiles(transcriptPath)]) {
        const previous = cache.files[filePath];
        const previousOffset = previous?.offset;
        const state = refreshFile(filePath, previous, prices);
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
        saveCache(cachePath, { priceVersion, files: nextFiles });
    }

    return summarize(Object.values(nextFiles), prices);
}
