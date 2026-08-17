import * as fs from 'fs';
import * as https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

import type { StatusJSON } from '../types/StatusJSON';

import {
    decodeKimiJwtPayload,
    resolveKimiWebAuthToken
} from './kimi-web-auth';
import type {
    UsageData,
    UsageError
} from './usage-types';

const CACHE_MAX_AGE_SECONDS = 180;
const LOCK_MAX_AGE_SECONDS = 30;
const DEFAULT_RATE_LIMIT_BACKOFF_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_API_BASE_URL = 'https://api.kimi.com';
const SUBSCRIPTION_STATS_URL = 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'ccstatusline');
const CACHE_FILE = path.join(CACHE_DIR, 'kimi-usage.json');
const LOCK_FILE = path.join(CACHE_DIR, 'kimi-usage.lock');

type UsageDataField = Exclude<keyof UsageData, 'error'>;

// UsageData plus bookkeeping for the web-only monthly membership pool: when no
// web session is available the absence is cached as conclusive (for one cache
// TTL) so renders do not retry the keychain/cookie lookup every time.
interface CachedKimiUsage extends UsageData { monthlyUnavailable?: boolean }

export interface FetchKimiUsageDataOptions { requiredFields?: readonly UsageDataField[] }

const KIMI_USAGE_FIELDS = new Set<UsageDataField>([
    'sessionUsage',
    'sessionResetAt',
    'weeklyUsage',
    'weeklyResetAt'
]);

const KIMI_MONTHLY_FIELDS = new Set<UsageDataField>([
    'monthlyUsage',
    'monthlyResetAt'
]);

const NumericValueSchema = z.union([z.number(), z.string()]).transform((value, context) => {
    const numericValue = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isFinite(numericValue)) {
        context.addIssue({ code: 'custom', message: 'Expected a finite numeric value' });
        return z.NEVER;
    }
    return numericValue;
});

const KimiUsageDetailSchema = z.looseObject({
    limit: NumericValueSchema,
    used: NumericValueSchema.nullable().optional(),
    remaining: NumericValueSchema.nullable().optional(),
    resetTime: z.string().nullable().optional(),
    resetAt: z.string().nullable().optional(),
    reset_time: z.string().nullable().optional(),
    reset_at: z.string().nullable().optional()
});

const KimiUsageResponseSchema = z.looseObject({
    usage: KimiUsageDetailSchema,
    limits: z.array(z.looseObject({ detail: KimiUsageDetailSchema })).nullable().optional()
});

const CachedKimiUsageSchema = z.looseObject({
    sessionUsage: z.number().optional(),
    sessionResetAt: z.string().optional(),
    weeklyUsage: z.number().optional(),
    weeklyResetAt: z.string().optional(),
    monthlyUsage: z.number().optional(),
    monthlyResetAt: z.string().optional(),
    monthlyUnavailable: z.boolean().optional()
});

const KimiSubscriptionStatsSchema = z.looseObject({
    subscriptionBalance: z.looseObject({
        amountUsedRatio: z.number().nullable().optional(),
        expireTime: z.string().nullable().optional()
    }).nullable().optional()
});

const KimiUsageLockSchema = z.object({
    blockedUntil: z.number(),
    error: z.enum(['timeout', 'rate-limited', 'api-error', 'parse-error'])
});

type KimiUsageLock = z.infer<typeof KimiUsageLockSchema>;
type KimiUsageDetail = z.infer<typeof KimiUsageDetailSchema>;
type KimiFetchResult
    = | { kind: 'success'; body: string }
        | { kind: 'rate-limited'; retryAfterSeconds: number }
        | { kind: 'auth-error' }
        | { kind: 'timeout' }
        | { kind: 'error' };

function getModelIdentifiers(model: StatusJSON['model']): string[] {
    if (typeof model === 'string') {
        return [model];
    }

    return [model?.id, model?.display_name].filter((value): value is string => typeof value === 'string');
}

function isKimiApiUrl(rawUrl: string | undefined): boolean {
    if (!rawUrl?.trim()) {
        return false;
    }

    try {
        const url = new URL(rawUrl);
        return url.hostname === 'kimi.com' || url.hostname.endsWith('.kimi.com');
    } catch {
        return false;
    }
}

export function resolveKimiCodeApiKey(
    environment: Record<string, string | undefined> = process.env
): string | undefined {
    const explicitKey = nonEmpty(environment.KIMI_CODE_API_KEY);
    if (explicitKey) {
        return explicitKey;
    }

    return isKimiApiUrl(environment.ANTHROPIC_BASE_URL)
        ? nonEmpty(environment.ANTHROPIC_AUTH_TOKEN)
        : undefined;
}

export function isKimiUsageContext(
    data: StatusJSON | undefined,
    environment: Record<string, string | undefined> = process.env
): boolean {
    const modelIdentifiers = getModelIdentifiers(data?.model);
    if (modelIdentifiers.some(identifier => identifier.toLowerCase().includes('kimi'))) {
        return true;
    }

    // A clearly Anthropic model id wins over env hints: mixed setups (Kimi env
    // left over while running Claude) must not be routed to the Kimi usage API.
    if (modelIdentifiers.some(identifier => identifier.toLowerCase().includes('claude'))) {
        return false;
    }

    const configuredModels = [
        environment.ANTHROPIC_MODEL,
        environment.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        environment.ANTHROPIC_DEFAULT_SONNET_MODEL,
        environment.ANTHROPIC_DEFAULT_OPUS_MODEL
    ];
    if (configuredModels.some(model => model?.toLowerCase().includes('kimi'))) {
        return true;
    }

    return isKimiApiUrl(environment.ANTHROPIC_BASE_URL);
}

function getResetTime(detail: KimiUsageDetail): string | undefined {
    return detail.resetTime
        ?? detail.resetAt
        ?? detail.reset_time
        ?? detail.reset_at
        ?? undefined;
}

function getUsedPercentage(detail: KimiUsageDetail): number | undefined {
    if (detail.limit <= 0) {
        return undefined;
    }

    const used = detail.used ?? (detail.remaining === null || detail.remaining === undefined
        ? undefined
        : detail.limit - detail.remaining);
    if (used === undefined) {
        return undefined;
    }

    return Math.max(0, Math.min(100, used / detail.limit * 100));
}

export function parseKimiUsageResponse(rawJson: string): UsageData | null {
    try {
        const parsed = KimiUsageResponseSchema.safeParse(JSON.parse(rawJson));
        if (!parsed.success) {
            return null;
        }

        const rateLimit = parsed.data.limits?.[0]?.detail;
        const usageData: UsageData = {
            weeklyUsage: getUsedPercentage(parsed.data.usage),
            weeklyResetAt: getResetTime(parsed.data.usage),
            sessionUsage: rateLimit ? getUsedPercentage(rateLimit) : undefined,
            sessionResetAt: rateLimit ? getResetTime(rateLimit) : undefined
        };

        return usageData.weeklyUsage === undefined && usageData.sessionUsage === undefined
            ? null
            : usageData;
    } catch {
        return null;
    }
}

export function parseKimiSubscriptionStats(rawJson: string): Pick<UsageData, 'monthlyUsage' | 'monthlyResetAt'> | null {
    try {
        const parsed = KimiSubscriptionStatsSchema.safeParse(JSON.parse(rawJson));
        if (!parsed.success) {
            return null;
        }

        const balance = parsed.data.subscriptionBalance;
        const ratio = balance?.amountUsedRatio;
        if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
            return null;
        }

        return {
            monthlyUsage: Math.max(0, Math.min(100, ratio * 100)),
            monthlyResetAt: balance?.expireTime ?? undefined
        };
    } catch {
        return null;
    }
}

function parseCachedUsage(rawJson: string): CachedKimiUsage | null {
    try {
        const parsed = CachedKimiUsageSchema.safeParse(JSON.parse(rawJson));
        if (!parsed.success) {
            return null;
        }

        return {
            sessionUsage: parsed.data.sessionUsage,
            sessionResetAt: parsed.data.sessionResetAt,
            weeklyUsage: parsed.data.weeklyUsage,
            weeklyResetAt: parsed.data.weeklyResetAt,
            monthlyUsage: parsed.data.monthlyUsage,
            monthlyResetAt: parsed.data.monthlyResetAt,
            monthlyUnavailable: parsed.data.monthlyUnavailable
        };
    } catch {
        return null;
    }
}

function ensureCacheDirExists(): void {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

function readCachedUsage(maxAgeSeconds?: number): UsageData | null {
    try {
        if (maxAgeSeconds !== undefined) {
            const ageSeconds = Math.floor(Date.now() / 1000) - Math.floor(fs.statSync(CACHE_FILE).mtimeMs / 1000);
            if (ageSeconds >= maxAgeSeconds) {
                return null;
            }
        }
        return parseCachedUsage(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch {
        return null;
    }
}

function hasRequiredFields(data: CachedKimiUsage, requiredFields: readonly UsageDataField[]): boolean {
    return requiredFields.every((field) => {
        if (KIMI_MONTHLY_FIELDS.has(field)) {
            return data[field] !== undefined || data.monthlyUnavailable === true;
        }
        return data[field] !== undefined;
    });
}

function staleUsageOrError(error: UsageError, requiredFields: readonly UsageDataField[]): UsageData {
    const stale = readCachedUsage();
    return stale && hasRequiredFields(stale, requiredFields) ? stale : { error };
}

function readActiveLock(now: number): KimiUsageLock | null {
    try {
        const parsed = KimiUsageLockSchema.safeParse(JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')));
        return parsed.success && parsed.data.blockedUntil > now ? parsed.data : null;
    } catch {
        return null;
    }
}

function writeLock(blockedUntil: number, error: KimiUsageLock['error']): void {
    try {
        ensureCacheDirExists();
        fs.writeFileSync(LOCK_FILE, JSON.stringify({ blockedUntil, error }));
    } catch {
        // Cache coordination is best-effort.
    }
}

function parseRetryAfterSeconds(value: string | string[] | undefined): number | null {
    const rawValue = Array.isArray(value) ? value[0] : value;
    if (!rawValue?.trim()) {
        return null;
    }

    if (/^\d+$/.test(rawValue.trim())) {
        const seconds = Number.parseInt(rawValue.trim(), 10);
        return seconds > 0 ? seconds : null;
    }

    const retryAt = Date.parse(rawValue);
    if (Number.isNaN(retryAt)) {
        return null;
    }
    const seconds = Math.ceil((retryAt - Date.now()) / 1000);
    return seconds > 0 ? seconds : null;
}

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed?.length ? trimmed : undefined;
}

export function getKimiUsageEndpoint(environment: Record<string, string | undefined> = process.env): URL | null {
    const rawBaseUrl = nonEmpty(environment.KIMI_CODE_BASE_URL) ?? DEFAULT_API_BASE_URL;

    try {
        const baseUrl = new URL(rawBaseUrl);
        if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) {
            return null;
        }

        const pathName = baseUrl.pathname.replace(/\/+$/, '');
        if (pathName.endsWith('/coding/v1')) {
            baseUrl.pathname = `${pathName}/usages`;
        } else if (pathName.endsWith('/coding')) {
            baseUrl.pathname = `${pathName}/v1/usages`;
        } else {
            baseUrl.pathname = `${pathName}/coding/v1/usages`;
        }
        return baseUrl;
    } catch {
        return null;
    }
}

function fetchFromKimiApi(apiKey: string, endpoint: URL): Promise<KimiFetchResult> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: KimiFetchResult) => {
            if (!settled) {
                settled = true;
                resolve(result);
            }
        };

        let agent: HttpsProxyAgent<string> | undefined;
        const proxyUrl = process.env.HTTPS_PROXY?.trim();
        try {
            agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
        } catch {
            finish({ kind: 'error' });
            return;
        }

        const request = https.request(endpoint, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${apiKey}`
            },
            timeout: REQUEST_TIMEOUT_MS,
            ...(agent ? { agent } : {})
        }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
                body += chunk;
            });
            response.on('end', () => {
                if (response.statusCode === 200 && body) {
                    finish({ kind: 'success', body });
                } else if (response.statusCode === 429) {
                    finish({
                        kind: 'rate-limited',
                        retryAfterSeconds: parseRetryAfterSeconds(response.headers['retry-after'])
                            ?? DEFAULT_RATE_LIMIT_BACKOFF_SECONDS
                    });
                } else if (response.statusCode === 401 || response.statusCode === 403) {
                    finish({ kind: 'auth-error' });
                } else {
                    finish({ kind: 'error' });
                }
            });
        });

        request.on('error', () => {
            finish({ kind: 'error' });
        });
        request.on('timeout', () => {
            request.destroy();
            finish({ kind: 'timeout' });
        });
        request.end();
    });
}

function buildKimiWebHeaders(token: string): Record<string, string> {
    const claims = decodeKimiJwtPayload(token);
    const deviceId = claims?.device_id;
    const sessionId = claims?.ssid;
    const trafficId = claims?.sub;

    return {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Cookie': `kimi-auth=${token}`,
        'Origin': 'https://www.kimi.com',
        'Referer': 'https://www.kimi.com/code/console',
        'connect-protocol-version': '1',
        'x-msh-platform': 'web',
        ...(typeof deviceId === 'string' ? { 'x-msh-device-id': deviceId } : {}),
        ...(typeof sessionId === 'string' ? { 'x-msh-session-id': sessionId } : {}),
        ...(typeof trafficId === 'string' ? { 'x-traffic-id': trafficId } : {})
    };
}

// Best-effort monthly membership pool fetch against the kimi.com web gateway.
// The gateway requires the kimi-auth web session JWT, not the coding API key.
// Returns the response body on HTTP 200, null on any failure.
function fetchKimiSubscriptionStats(webAuthToken: string): Promise<string | null> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (body: string | null) => {
            if (!settled) {
                settled = true;
                resolve(body);
            }
        };

        let agent: HttpsProxyAgent<string> | undefined;
        const proxyUrl = process.env.HTTPS_PROXY?.trim();
        try {
            agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
        } catch {
            finish(null);
            return;
        }

        const request = https.request(SUBSCRIPTION_STATS_URL, {
            method: 'POST',
            headers: buildKimiWebHeaders(webAuthToken),
            timeout: REQUEST_TIMEOUT_MS,
            ...(agent ? { agent } : {})
        }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
                body += chunk;
            });
            response.on('end', () => {
                finish(response.statusCode === 200 && body ? body : null);
            });
        });

        request.on('error', () => { finish(null); });
        request.on('timeout', () => {
            request.destroy();
            finish(null);
        });
        request.end('{}');
    });
}

async function resolveMonthlyUsage(
    monthlyRequired: boolean,
    statsRequest: Promise<string | null> | null
): Promise<Pick<CachedKimiUsage, 'monthlyUsage' | 'monthlyResetAt' | 'monthlyUnavailable'>> {
    if (!monthlyRequired) {
        return {};
    }
    if (!statsRequest) {
        return { monthlyUnavailable: true };
    }

    const body = await statsRequest;
    const stats = body ? parseKimiSubscriptionStats(body) : null;
    return stats
        ? { monthlyUsage: stats.monthlyUsage, monthlyResetAt: stats.monthlyResetAt }
        : { monthlyUnavailable: true };
}

export async function fetchKimiUsageData(options: FetchKimiUsageDataOptions = {}): Promise<UsageData> {
    const requiredFields = (options.requiredFields ?? []).filter(field => KIMI_USAGE_FIELDS.has(field) || KIMI_MONTHLY_FIELDS.has(field));
    if (options.requiredFields?.length && requiredFields.length === 0) {
        return {};
    }

    const freshCache = readCachedUsage(CACHE_MAX_AGE_SECONDS);
    if (freshCache && hasRequiredFields(freshCache, requiredFields)) {
        return freshCache;
    }

    const apiKey = resolveKimiCodeApiKey();
    if (!apiKey) {
        return staleUsageOrError('no-credentials', requiredFields);
    }

    const endpoint = getKimiUsageEndpoint();
    if (!endpoint) {
        return staleUsageOrError('api-error', requiredFields);
    }

    const now = Math.floor(Date.now() / 1000);
    const activeLock = readActiveLock(now);
    if (activeLock) {
        return staleUsageOrError(activeLock.error, requiredFields);
    }
    writeLock(now + LOCK_MAX_AGE_SECONDS, 'timeout');

    // Resolve the web session and start the monthly stats request up front so
    // it overlaps the coding API call instead of doubling render latency.
    const monthlyRequired = requiredFields.some(field => KIMI_MONTHLY_FIELDS.has(field));
    const webAuthToken = monthlyRequired ? resolveKimiWebAuthToken() : null;
    const statsRequest = webAuthToken ? fetchKimiSubscriptionStats(webAuthToken) : null;

    const response = await fetchFromKimiApi(apiKey, endpoint);
    if (response.kind === 'auth-error') {
        return staleUsageOrError('no-credentials', requiredFields);
    }
    if (response.kind === 'rate-limited') {
        writeLock(now + response.retryAfterSeconds, 'rate-limited');
        return staleUsageOrError('rate-limited', requiredFields);
    }
    if (response.kind === 'timeout') {
        return staleUsageOrError('timeout', requiredFields);
    }
    if (response.kind === 'error') {
        return staleUsageOrError('api-error', requiredFields);
    }

    const usageData = parseKimiUsageResponse(response.body);
    if (!usageData) {
        writeLock(now + LOCK_MAX_AGE_SECONDS, 'parse-error');
        return staleUsageOrError('parse-error', requiredFields);
    }

    const monthlyData = await resolveMonthlyUsage(monthlyRequired, statsRequest);
    const mergedUsage: CachedKimiUsage = { ...usageData, ...monthlyData };

    try {
        ensureCacheDirExists();
        fs.writeFileSync(CACHE_FILE, JSON.stringify(mergedUsage));
    } catch {
        // Cache writes are best-effort.
    }
    return mergedUsage;
}
