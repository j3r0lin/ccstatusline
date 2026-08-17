import * as fs from 'fs';
import * as https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

import type { StatusJSON } from '../types/StatusJSON';

import type {
    UsageData,
    UsageError
} from './usage-types';

const CACHE_MAX_AGE_SECONDS = 180;
const LOCK_MAX_AGE_SECONDS = 30;
const DEFAULT_RATE_LIMIT_BACKOFF_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_API_BASE_URL = 'https://api.kimi.com';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'ccstatusline');
const CACHE_FILE = path.join(CACHE_DIR, 'kimi-usage.json');
const LOCK_FILE = path.join(CACHE_DIR, 'kimi-usage.lock');

type UsageDataField = Exclude<keyof UsageData, 'error'>;

export interface FetchKimiUsageDataOptions { requiredFields?: readonly UsageDataField[] }

const KIMI_USAGE_FIELDS = new Set<UsageDataField>([
    'sessionUsage',
    'sessionResetAt',
    'weeklyUsage',
    'weeklyResetAt'
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
    weeklyResetAt: z.string().optional()
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

function parseCachedUsage(rawJson: string): UsageData | null {
    try {
        const parsed = CachedKimiUsageSchema.safeParse(JSON.parse(rawJson));
        return parsed.success ? parsed.data : null;
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

function hasRequiredFields(data: UsageData, requiredFields: readonly UsageDataField[]): boolean {
    return requiredFields.every(field => data[field] !== undefined);
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

export async function fetchKimiUsageData(options: FetchKimiUsageDataOptions = {}): Promise<UsageData> {
    const requiredFields = (options.requiredFields ?? []).filter(field => KIMI_USAGE_FIELDS.has(field));
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

    try {
        ensureCacheDirExists();
        fs.writeFileSync(CACHE_FILE, JSON.stringify(usageData));
    } catch {
        // Cache writes are best-effort.
    }
    return usageData;
}
