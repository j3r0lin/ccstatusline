import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

import type { StatusJSON } from '../types/StatusJSON';

import type {
    UsageData,
    UsageError
} from './usage-types';

const REQUEST_TIMEOUT_MS = 3000;
// Every session's render shares one reading: concurrent sessions would
// otherwise each ask the gateway on every refresh.
const FRESH_MAX_AGE_SECONDS = 30;
const CACHE_DIR = path.join(os.homedir(), '.cache', 'ccstatusline');
const CACHE_FILE = path.join(CACHE_DIR, 'magpie-usage.json');
// A stale reading can mislead once its billing window has rolled over.
const STALE_MAX_AGE_SECONDS = 900;
const AFFINITY_FILE = path.join(os.homedir(), '.config', 'magpie', 'affinity.json');

type UsageDataField = Exclude<keyof UsageData, 'error'>;

export interface FetchMagpieUsageDataOptions {
    requiredFields?: readonly UsageDataField[];
    environment?: Record<string, string | undefined>;
    sessionId?: string;
    modelId?: string;
    affinityFile?: string;
    cacheFile?: string;
}

const MAGPIE_USAGE_FIELDS = new Set<UsageDataField>([
    'sessionUsage',
    'sessionResetAt',
    'weeklyUsage',
    'weeklyResetAt',
    'monthlyUsage',
    'monthlyResetAt'
]);

// magpie names rolling windows by their length, so "5 hours" and "7 days" mean
// the same quota for every provider, and a plan's monthly window is "Month".
// Only providers that name windows otherwise are listed; any other name is not
// guessed, as it may be a different quota. Kimi's monthly pool is a rolling
// "30 days" window that the Surge script adds to Kimi's usage reply.
interface WindowNames { session?: string; weekly?: string; monthly?: string }
const DEFAULT_WINDOWS: WindowNames = { session: '5 hours', weekly: '7 days', monthly: 'Month' };
const PROVIDER_WINDOWS: Record<string, WindowNames> = {
    cursor: { weekly: 'Cursor Models' },
    kimi: { ...DEFAULT_WINDOWS, monthly: '30 days' }
};

const QuotaWindowSchema = z.looseObject({
    name: z.string(),
    pool: z.string().nullable().optional(),
    used: z.number().nullable().optional(),
    resetsAt: z.string().nullable().optional()
});

const QuotaEntrySchema = z.looseObject({
    provider: z.string(),
    user: z.string().nullable().optional(),
    alias: z.string().nullable().optional(),
    windows: z.array(QuotaWindowSchema).nullable().optional()
});

const QuotasResponseSchema = z.looseObject({ data: z.array(QuotaEntrySchema) });

type QuotaEntry = z.infer<typeof QuotaEntrySchema>;
type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

function getModelIdentifiers(model: StatusJSON['model']): string[] {
    if (typeof model === 'string') {
        return [model];
    }

    return [model?.id, model?.display_name].filter((value): value is string => typeof value === 'string');
}

function parseLoopbackGateway(rawUrl: string | undefined): URL | null {
    if (!rawUrl?.trim()) {
        return null;
    }

    try {
        const url = new URL(rawUrl);
        const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
        return url.protocol === 'http:' && isLoopback ? url : null;
    } catch {
        return null;
    }
}

export function isMagpieGateway(environment: Record<string, string | undefined> = process.env): boolean {
    return parseLoopbackGateway(environment.ANTHROPIC_BASE_URL) !== null;
}

// Any model through the local gateway: routing groups such as sonnet-tier name
// no vendor, so the served provider is resolved per session.
export function isMagpieUsageContext(
    data: StatusJSON | undefined,
    environment: Record<string, string | undefined> = process.env
): boolean {
    return isMagpieGateway(environment) && getModelIdentifiers(data?.model).length > 0;
}

function findWindow(windows: readonly QuotaWindow[], name: string, poolName?: string): QuotaWindow | undefined {
    const wanted = name.trim().toLowerCase();
    const pooledWanted = poolName ? `${poolName.trim().toLowerCase()} · ${wanted}` : undefined;
    return windows.find((window) => {
        const actual = window.name.trim().toLowerCase();
        return actual === wanted || (pooledWanted !== undefined && actual === pooledWanted);
    });
}

function normalizeTokens(value: string): string[] {
    return value
        .trim()
        .toLowerCase()
        .split(/[^a-z0-9.]+/)
        .filter(Boolean);
}

function stripModelDecorations(modelId: string): string {
    const bare = modelId.split('/').pop() ?? modelId;
    return bare.replace(/\[[^\]]+\]$/, '').split('@')[0] ?? '';
}

function scorePoolMatch(pool: string, modelTokens: Set<string>): number {
    // Pools like "Claude & GPT" join multiple families with "&" or ",".
    // Pick the pool with the most matched tokens so "Gemini 4 Argon" beats "Gemini" for gemini-4-argon.
    let bestScore = 0;
    for (const branch of pool.split(/[&,]/)) {
        const tokens = normalizeTokens(branch);
        if (tokens.length > 0 && tokens.every(token => modelTokens.has(token))) {
            bestScore = Math.max(bestScore, tokens.length);
        }
    }
    return bestScore;
}

function selectPoolForModel(windows: readonly QuotaWindow[], modelId: string | undefined): string | undefined {
    const pools = Array.from(new Set(
        windows
            .map(window => window.pool?.trim())
            .filter((pool): pool is string => Boolean(pool))
    ));
    if (pools.length === 0) {
        return undefined;
    }
    if (pools.length === 1) {
        return pools[0];
    }
    if (!modelId?.trim()) {
        return undefined;
    }

    const modelTokens = new Set(normalizeTokens(stripModelDecorations(modelId)));
    let selectedPool: string | undefined;
    let bestScore = 0;
    let tied = false;

    for (const pool of pools) {
        const score = scorePoolMatch(pool, modelTokens);
        if (score > bestScore) {
            bestScore = score;
            selectedPool = pool;
            tied = false;
        } else if (score > 0 && score === bestScore) {
            tied = true;
        }
    }

    return tied ? undefined : selectedPool;
}

function toUsageFields(window: QuotaWindow | undefined): { usage?: number; resetAt?: string } {
    if (!window || typeof window.used !== 'number') {
        return {};
    }

    return {
        usage: Math.max(0, Math.min(100, window.used)),
        resetAt: window.resetsAt ?? undefined
    };
}

function accountEmail(user: string | null | undefined): string | undefined {
    const email = user?.split('·')[0]?.trim().toLowerCase();
    return email === undefined || email === '' ? undefined : email;
}

export interface MagpieAccount {
    provider: string;
    // Absent for providers whose accounts magpie identifies by an opaque id, such as kimi.
    email?: string;
    // True when the session's model is a routing group (e.g. sonnet-tier) whose
    // provider varies per session.
    routed?: boolean;
    // The model magpie sent the session's latest turn to, as it recorded in affinity.json.
    model?: string;
}

function pickAccount(entries: readonly QuotaEntry[], account: MagpieAccount): QuotaEntry | undefined {
    const candidates = entries.filter(entry => entry.provider === account.provider);
    if (account.email) {
        return candidates.find(entry => accountEmail(entry.user) === account.email);
    }
    // Without an email the entry is only certain when the provider has one account.
    return candidates.length === 1 ? candidates[0] : undefined;
}

// The provider and account behind a session are per session, not global:
// concurrent sessions can sit on different Claude accounts, and a routing group
// like sonnet-tier can put one session on Claude and another on Codex or Grok.
// magpie records the pick in affinity.json under "<provider or group>/<model>|<session>";
// a Claude session it never pinned runs on the account Claude Code is logged in to.
export function resolveSessionAccount(
    sessionId: string | undefined,
    modelId: string | undefined,
    environment: Record<string, string | undefined> = process.env,
    affinityFile = AFFINITY_FILE
): MagpieAccount | undefined {
    const pinned = sessionId && modelId ? readPinnedAccount(sessionId, modelId, affinityFile) : undefined;
    if (pinned) {
        return pinned;
    }

    const loginEmail = modelId?.toLowerCase().includes('claude') ? readLoggedInEmail(environment) : undefined;
    return loginEmail ? { provider: 'claude', email: loginEmail } : undefined;
}

function readPinnedAccount(sessionId: string, modelId: string, affinityFile: string): MagpieAccount | undefined {
    try {
        const entries = Object.entries(JSON.parse(fs.readFileSync(affinityFile, 'utf8')) as Record<string, { who?: string; at?: string; model?: string }>);
        // Claude Code reports a routing group as "group/sonnet-tier", which is already the affinity key's prefix and name.
        const bareModelId = modelId.replace(/^group\//, '');
        const latest = entries
            .filter(([key, value]) => key === `${key.split('/')[0]}/${bareModelId}|${sessionId}` && typeof value.who === 'string')
            .sort(([, left], [, right]) => Date.parse(right.at ?? '') - Date.parse(left.at ?? ''))[0];
        // `who` is "<provider>@<email>" ("claude@platform2@inhand.com · inhand") or "<provider>#<id>" ("kimi#670d5e5763").
        const match = /^([^@#]+)([@#])(.+)$/.exec(latest?.[1].who ?? '');
        if (!match) {
            return undefined;
        }
        const [, provider, separator, identifier] = match;
        const email = separator === '@' ? accountEmail(identifier) : undefined;
        return { provider: provider ?? '', email, routed: latest?.[0].startsWith('group/'), model: latest?.[1].model };
    } catch {
        return undefined;
    }
}

function readLoggedInEmail(environment: Record<string, string | undefined>): string | undefined {
    const configDir = environment.CLAUDE_CONFIG_DIR?.trim();
    const configFile = configDir ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
    try {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as { oauthAccount?: { emailAddress?: string } };
        return accountEmail(config.oauthAccount?.emailAddress);
    } catch {
        return undefined;
    }
}

export function parseMagpieQuotaResponse(rawJson: string, account: MagpieAccount | undefined): UsageData | null {
    try {
        if (!account) {
            return null;
        }
        const parsed = QuotasResponseSchema.safeParse(JSON.parse(rawJson));
        if (!parsed.success) {
            return null;
        }

        const windowNames = PROVIDER_WINDOWS[account.provider] ?? DEFAULT_WINDOWS;

        const windows = pickAccount(parsed.data.data, account)?.windows ?? [];
        const unpooledWindows = windows.filter(window => !window.pool?.trim());
        const resolveUsage = (targetWindows: readonly QuotaWindow[], poolName?: string) => {
            const usageOfWindow = (name: string | undefined) => toUsageFields(
                name ? findWindow(targetWindows, name, poolName) : undefined
            );
            return {
                session: usageOfWindow(windowNames.session),
                weekly: usageOfWindow(windowNames.weekly),
                monthly: usageOfWindow(windowNames.monthly)
            };
        };

        let resolved = resolveUsage(unpooledWindows);
        const hasAnyField = (candidate: typeof resolved) => [
            candidate.session.usage,
            candidate.session.resetAt,
            candidate.weekly.usage,
            candidate.weekly.resetAt,
            candidate.monthly.usage,
            candidate.monthly.resetAt
        ].some(value => value !== undefined);

        if (!hasAnyField(resolved)) {
            const selectedPool = selectPoolForModel(windows, account.model);
            if (!selectedPool) {
                return null;
            }
            const poolWindows = windows.filter(window => window.pool?.trim().toLowerCase() === selectedPool.toLowerCase());
            resolved = resolveUsage(poolWindows, selectedPool);
        }

        const { session, weekly, monthly } = resolved;

        const usageData: UsageData = {
            sessionUsage: session.usage,
            sessionResetAt: session.resetAt,
            weeklyUsage: weekly.usage,
            weeklyResetAt: weekly.resetAt,
            monthlyUsage: monthly.usage,
            monthlyResetAt: monthly.resetAt
        };

        if (!Object.values(usageData).some(value => value !== undefined)) {
            return null;
        }
        return session.usage === undefined ? { ...usageData, sessionWindowUnavailable: true } : usageData;
    } catch {
        return null;
    }
}

export interface MagpieAccountDetails {
    // How many accounts magpie knows for the account's provider.
    providerAccountCount: number;
    // The name set with `magpie accounts alias`.
    alias?: string;
}

// Read from the last quotas reading the usage fetch cached; undefined when
// there is no reading yet.
export function describeAccount(account: MagpieAccount, cacheFile = CACHE_FILE): MagpieAccountDetails | undefined {
    const body = readCachedBody(Number.POSITIVE_INFINITY, cacheFile);
    if (!body) {
        return undefined;
    }
    try {
        const parsed = QuotasResponseSchema.safeParse(JSON.parse(body));
        if (!parsed.success) {
            return undefined;
        }
        const alias = pickAccount(parsed.data.data, account)?.alias?.trim();
        return {
            providerAccountCount: parsed.data.data.filter(entry => entry.provider === account.provider).length,
            alias: alias === undefined || alias === '' ? undefined : alias
        };
    } catch {
        return undefined;
    }
}

function readCachedBody(maxAgeSeconds: number, cacheFile = CACHE_FILE): string | null {
    try {
        const ageSeconds = Math.floor((Date.now() - fs.statSync(cacheFile).mtimeMs) / 1000);
        return ageSeconds < maxAgeSeconds ? fs.readFileSync(cacheFile, 'utf8') : null;
    } catch {
        return null;
    }
}

// The cache holds the gateway's raw answer, which is the same for every
// session; each session picks its own account out of it. Rename keeps a
// concurrent reader from seeing a half-written file.
function writeCachedBody(body: string, cacheFile = CACHE_FILE): void {
    const tempFile = `${cacheFile}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(tempFile, body);
        fs.renameSync(tempFile, cacheFile);
    } catch {
        // Cache writes are best-effort.
    }
}

function usageFromBodyOrError(body: string | null, account: MagpieAccount | undefined, error: UsageError): UsageData {
    return (body ? parseMagpieQuotaResponse(body, account) : null) ?? { error };
}

type GatewayResult = { kind: 'success'; body: string } | { kind: 'timeout' } | { kind: 'error' };

function getFromGateway(endpoint: URL): Promise<GatewayResult> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: GatewayResult) => {
            if (!settled) {
                settled = true;
                resolve(result);
            }
        };

        const request = http.get(endpoint, { headers: { Accept: 'application/json' }, timeout: REQUEST_TIMEOUT_MS }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
                body += chunk;
            });
            response.on('end', () => { finish(response.statusCode === 200 && body ? { kind: 'success', body } : { kind: 'error' }); });
            response.on('error', () => { finish({ kind: 'error' }); });
        });
        request.on('timeout', () => {
            request.destroy();
            finish({ kind: 'timeout' });
        });
        request.on('error', () => { finish({ kind: 'error' }); });
    });
}

export async function fetchMagpieUsageData(options: FetchMagpieUsageDataOptions = {}): Promise<UsageData> {
    const requiredFields = (options.requiredFields ?? []).filter(field => MAGPIE_USAGE_FIELDS.has(field));
    if (options.requiredFields?.length && requiredFields.length === 0) {
        return {};
    }

    const environment = options.environment ?? process.env;
    const gateway = parseLoopbackGateway(environment.ANTHROPIC_BASE_URL);
    if (!gateway) {
        return { error: 'no-credentials' };
    }
    // A routing group has no account until it serves the session's first request.
    const account = resolveSessionAccount(options.sessionId, options.modelId, environment, options.affinityFile);
    if (!account) {
        return {};
    }
    const effectiveAccount = account.model || account.routed || !options.modelId
        ? account
        : { ...account, model: options.modelId };

    const cacheFile = options.cacheFile ?? CACHE_FILE;
    const freshBody = readCachedBody(FRESH_MAX_AGE_SECONDS, cacheFile);
    const freshUsage = freshBody ? parseMagpieQuotaResponse(freshBody, effectiveAccount) : null;
    if (freshUsage) {
        return freshUsage;
    }

    // ?kept=1 returns magpie's last-read windows immediately without polling slow vendors live.
    const response = await getFromGateway(new URL('/v1/magpie/quotas?kept=1', gateway.origin));
    if (response.kind !== 'success') {
        return usageFromBodyOrError(readCachedBody(STALE_MAX_AGE_SECONDS, cacheFile), effectiveAccount, response.kind === 'timeout' ? 'timeout' : 'api-error');
    }

    const usageData = parseMagpieQuotaResponse(response.body, effectiveAccount);
    if (!usageData) {
        return { error: 'parse-error' };
    }

    writeCachedBody(response.body, cacheFile);
    return usageData;
}
