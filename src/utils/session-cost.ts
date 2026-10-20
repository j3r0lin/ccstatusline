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
    /** Digest of the last ledger content written to each path, so a render can skip an unchanged write without reading the file. */
    ledger?: Record<string, string>;
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

interface ModelCost {
    /** Null when the model has no known price. */
    usd: number | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

interface FileCost {
    /** Priced messages only; an unpriced model adds nothing. */
    totalUsd: number;
    allClaude: boolean;
    hasUnknown: boolean;
    byModel: Record<string, ModelCost>;
}

function costFile(file: FileState, prices: ModelPrices): FileCost {
    const cost: FileCost = { totalUsd: 0, allClaude: true, hasUnknown: false, byModel: {} };

    for (const [model, byTier] of Object.entries(file.models)) {
        if (!isClaudeModel(model)) {
            cost.allClaude = false;
        }
        const key = resolvePriceKey(model);
        const price = key === null ? undefined : prices[key];
        const modelCost: ModelCost = {
            usd: price ? 0 : null,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0
        };
        cost.byModel[model] = modelCost;

        for (const [tierIndex, tokens] of Object.entries(byTier)) {
            modelCost.inputTokens += tokens.input;
            modelCost.outputTokens += tokens.output;
            modelCost.cacheReadTokens += tokens.cacheRead;
            modelCost.cacheWriteTokens += tokens.write5m + tokens.write1h;
            if (price) {
                const usd = priceTokens(price, Number(tierIndex), tokens);
                modelCost.usd = (modelCost.usd ?? 0) + usd;
                cost.totalUsd += usd;
            }
        }
        if (!price) {
            cost.hasUnknown = true;
        }
    }

    return cost;
}

function summarize(files: FileCost[]): SessionCostSummary {
    return {
        total: files.reduce((sum, file) => sum + file.totalUsd, 0),
        allClaude: files.every(file => file.allClaude),
        hasUnknown: files.some(file => file.hasUnknown)
    };
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
        const state = readSessionCost(transcriptPath, prices);
        return state ? summarize(Object.values(state.costs)) : null;
    } catch {
        return null;
    }
}

interface SessionCostState {
    cache: CostCache;
    cachePath: string;
    /** Per transcript file, main transcript first. */
    costs: Record<string, FileCost>;
}

function readSessionCost(transcriptPath: string, prices: ModelPrices): SessionCostState | null {
    if (!fs.existsSync(transcriptPath)) {
        return null;
    }

    const cachePath = getCachePath(transcriptPath);
    const priceVersion = getPriceVersion(prices);
    const loaded = loadCache(cachePath, priceVersion);
    const nextFiles: Record<string, FileState> = {};
    let changed = false;

    for (const filePath of [transcriptPath, ...getSubagentFiles(transcriptPath)]) {
        const previous = loaded.files[filePath];
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

    if (Object.keys(nextFiles).length !== Object.keys(loaded.files).length) {
        changed = true;
    }
    const cache: CostCache = { priceVersion, files: nextFiles, ledger: loaded.ledger };
    if (changed) {
        saveCache(cachePath, cache);
    }

    const costs: Record<string, FileCost> = {};
    for (const [filePath, state] of Object.entries(nextFiles)) {
        costs[filePath] = costFile(state, prices);
    }
    return { cache, cachePath, costs };
}

export interface SessionCostResult {
    /** What the widget shows; undefined when there is nothing to show. */
    totalUsd: number | undefined;
    /** True when the shown total is Claude Code's number for a session holding an unpriced model. */
    approximate: boolean;
    source: 'computed' | 'claude-code';
}

function sortedByModel(byModel: Record<string, ModelCost>): Record<string, ModelCost> {
    return Object.fromEntries(Object.entries(byModel).sort(([a], [b]) => a.localeCompare(b)));
}

function digest(content: object): string {
    return createHash('sha1').update(JSON.stringify(content)).digest('hex');
}

/**
 * Writes `content` (stamped with `updatedAt`) to `target` unless its digest matches the last
 * write and the file is still there. Returns whether the digest map changed.
 */
function writeLedgerFile(ledger: Record<string, string>, target: string, content: object): boolean {
    const hash = digest(content);
    if (ledger[target] === hash && fs.existsSync(target)) {
        return false;
    }
    const tmpPath = `${target}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(tmpPath, `${JSON.stringify({ ...content, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf-8');
        fs.renameSync(tmpPath, target);
    } catch {
        // Best-effort: the next render retries, and the widget output does not depend on it
        try {
            fs.rmSync(tmpPath, { force: true });
        } catch {
            // Nothing more to do for a tmp file that cannot be removed
        }
        return false;
    }
    ledger[target] = hash;
    return true;
}

function recordLedger(transcriptPath: string, state: SessionCostState, result: SessionCostResult): void {
    const { costs, cache } = state;
    const sessionDir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'));
    const ledger = cache.ledger ??= {};
    const before = JSON.stringify(ledger);

    const byModel: Record<string, ModelCost> = {};
    const agentTargets: [string, string][] = [];
    for (const [filePath, cost] of Object.entries(costs)) {
        if (filePath !== transcriptPath) {
            const agentId = path.basename(filePath, '.jsonl').replace(/^agent-/, '');
            agentTargets.push([agentId, filePath]);
        }
        for (const [model, modelCost] of Object.entries(cost.byModel)) {
            const sum = byModel[model] ??= { usd: modelCost.usd === null ? null : 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
            sum.usd = sum.usd === null || modelCost.usd === null ? null : sum.usd + modelCost.usd;
            sum.inputTokens += modelCost.inputTokens;
            sum.outputTokens += modelCost.outputTokens;
            sum.cacheReadTokens += modelCost.cacheReadTokens;
            sum.cacheWriteTokens += modelCost.cacheWriteTokens;
        }
    }

    const summary = summarize(Object.values(costs));
    const shown = result.totalUsd !== undefined;
    writeLedgerFile(ledger, path.join(sessionDir, 'cost.json'), {
        sessionId: path.basename(transcriptPath, '.jsonl'),
        totalUsd: result.totalUsd ?? summary.total,
        approximate: shown ? result.approximate : summary.hasUnknown,
        source: shown ? result.source : 'computed',
        byModel: sortedByModel(byModel)
    });

    for (const [agentId, filePath] of agentTargets) {
        const cost = costs[filePath];
        if (!cost) {
            continue;
        }
        writeLedgerFile(ledger, path.join(path.dirname(filePath), `agent-${agentId}.cost.json`), {
            agentId,
            totalUsd: cost.totalUsd,
            approximate: cost.hasUnknown,
            byModel: sortedByModel(cost.byModel)
        });
    }

    if (JSON.stringify(ledger) !== before) {
        saveCache(state.cachePath, cache);
    }
}

/**
 * Decides the session cost to show and records it beside Claude Code's own session files.
 *
 * @remarks
 * Claude Code prices every message at Anthropic list prices, which is wrong once the
 * gateway routes to other models. All-Claude sessions keep its number, which also covers
 * calls the transcript never records. The record is `<session dir>/cost.json` plus
 * `subagents/agent-<id>.cost.json` per subagent, written only when their content changed.
 *
 * @param claudeCodeTotal - `cost.total_cost_usd` from Claude Code's status payload
 */
export function resolveSessionCost(
    transcriptPath: string | undefined,
    claudeCodeTotal: number | undefined,
    prices: ModelPrices = getModelPrices()
): SessionCostResult {
    let result: SessionCostResult = { totalUsd: claudeCodeTotal, approximate: false, source: 'claude-code' };
    if (!transcriptPath) {
        return result;
    }

    let state: SessionCostState | null;
    try {
        state = readSessionCost(transcriptPath, prices);
    } catch {
        return result;
    }
    if (!state) {
        return result;
    }

    const summary = summarize(Object.values(state.costs));
    if (!summary.allClaude) {
        result = summary.hasUnknown
            ? { totalUsd: claudeCodeTotal, approximate: true, source: 'claude-code' }
            : { totalUsd: summary.total, approximate: false, source: 'computed' };
    }

    try {
        recordLedger(transcriptPath, state, result);
    } catch {
        // The record is a side channel; it never hides the widget output
    }
    return result;
}
