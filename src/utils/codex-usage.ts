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
const DEFAULT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const REFRESH_URL = 'https://auth.openai.com/oauth/token';
// Public Codex CLI OAuth client id (same as CodexBar / codex CLI).
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'ccstatusline');
const CACHE_FILE = path.join(CACHE_DIR, 'codex-usage.json');
const LOCK_FILE = path.join(CACHE_DIR, 'codex-usage.lock');

type UsageDataField = Exclude<keyof UsageData, 'error'>;

export interface FetchCodexUsageDataOptions { requiredFields?: readonly UsageDataField[] }

export interface CodexCredentials {
    accessToken: string;
    refreshToken?: string;
    accountId?: string;
    idToken?: string;
    lastRefresh?: string;
}

const CODEX_USAGE_FIELDS = new Set<UsageDataField>([
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

const WindowSnapshotSchema = z.looseObject({
    used_percent: NumericValueSchema.optional(),
    usedPercent: NumericValueSchema.optional(),
    reset_at: NumericValueSchema.optional(),
    resetAt: NumericValueSchema.optional(),
    limit_window_seconds: NumericValueSchema.optional(),
    limitWindowSeconds: NumericValueSchema.optional()
});

const RateLimitDetailsSchema = z.looseObject({
    primary_window: WindowSnapshotSchema.nullable().optional(),
    primaryWindow: WindowSnapshotSchema.nullable().optional(),
    secondary_window: WindowSnapshotSchema.nullable().optional(),
    secondaryWindow: WindowSnapshotSchema.nullable().optional()
});

const CodexUsageResponseSchema = z.looseObject({
    rate_limit: RateLimitDetailsSchema.nullable().optional(),
    rateLimit: RateLimitDetailsSchema.nullable().optional()
});

const CachedCodexUsageSchema = z.looseObject({
    sessionUsage: z.number().optional(),
    sessionResetAt: z.string().optional(),
    weeklyUsage: z.number().optional(),
    weeklyResetAt: z.string().optional()
});

const CodexUsageLockSchema = z.object({
    blockedUntil: z.number(),
    error: z.enum(['timeout', 'rate-limited', 'api-error', 'parse-error'])
});

type CodexUsageLock = z.infer<typeof CodexUsageLockSchema>;
type WindowSnapshot = z.infer<typeof WindowSnapshotSchema>;
type CodexFetchResult
    = | { kind: 'success'; body: string }
        | { kind: 'rate-limited'; retryAfterSeconds: number }
        | { kind: 'auth-error' }
        | { kind: 'timeout' }
        | { kind: 'error' };

function nonEmpty(value: string | undefined | null): string | undefined {
    const trimmed = value?.trim();
    return trimmed?.length ? trimmed : undefined;
}

function getModelIdentifiers(model: StatusJSON['model']): string[] {
    if (typeof model === 'string') {
        return [model];
    }

    return [model?.id, model?.display_name].filter((value): value is string => typeof value === 'string');
}

function isCodexModelIdentifier(value: string | undefined): boolean {
    if (!value) {
        return false;
    }
    const lower = value.toLowerCase();
    // GPT-5.6 tier short names (Sol / Terra / Luna) appear both as bare aliases and
    // as suffixes on gpt-5.x ids (e.g. gpt-5.6-sol, openai/gpt-5.6-terra).
    const gpt56Tier = '(?:sol|terra|luna)';
    return lower.includes('codex')
        || lower.includes('chatgpt-codex')
        || new RegExp(`(?:^|/)gpt-5(?:\\.\\d+)?(?:-${gpt56Tier}|-codex)?(?:$|[^a-z0-9])`, 'i').test(value)
        || new RegExp(`(?:^|/)gpt-5(?:\\.\\d+)?-${gpt56Tier}$`, 'i').test(value)
        || new RegExp(`(?:^|/)${gpt56Tier}$`, 'i').test(value);
}

export function isCodexApiUrl(rawUrl: string | undefined): boolean {
    if (!rawUrl?.trim()) {
        return false;
    }

    try {
        const hostname = new URL(rawUrl).hostname.toLowerCase();
        return hostname === 'chatgpt.com'
            || hostname.endsWith('.chatgpt.com')
            || hostname === 'api.openai.com'
            || hostname.endsWith('.openai.com')
            || hostname === 'chat.openai.com';
    } catch {
        return false;
    }
}

export function isCodexUsageContext(
    data: StatusJSON | undefined,
    environment: Record<string, string | undefined> = process.env
): boolean {
    const modelIdentifiers = getModelIdentifiers(data?.model);
    if (modelIdentifiers.length > 0) {
        return modelIdentifiers.some(isCodexModelIdentifier);
    }

    const configuredModels = [
        environment.ANTHROPIC_MODEL,
        environment.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        environment.ANTHROPIC_DEFAULT_SONNET_MODEL,
        environment.ANTHROPIC_DEFAULT_OPUS_MODEL
    ];
    if (configuredModels.some(isCodexModelIdentifier)) {
        return true;
    }

    return isCodexApiUrl(environment.ANTHROPIC_BASE_URL);
}

export function getCodexHomeURL(
    environment: Record<string, string | undefined> = process.env,
    homeDir: string = os.homedir()
): string {
    const custom = nonEmpty(environment.CODEX_HOME);
    if (custom) {
        return path.resolve(custom.startsWith('~')
            ? custom.replace(/^~(?=$|[/\\])/, homeDir)
            : custom);
    }

    return path.join(homeDir, '.codex');
}

export function getCodexAuthFilePath(
    environment: Record<string, string | undefined> = process.env,
    homeDir: string = os.homedir()
): string {
    return path.join(getCodexHomeURL(environment, homeDir), 'auth.json');
}

export function parseCodexAuthJson(rawJson: string): CodexCredentials | null {
    try {
        const parsed = JSON.parse(rawJson) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }

        const root = parsed as Record<string, unknown>;
        const openaiKey = nonEmpty(typeof root.OPENAI_API_KEY === 'string' ? root.OPENAI_API_KEY : undefined);
        const tokens = root.tokens && typeof root.tokens === 'object' && !Array.isArray(root.tokens)
            ? root.tokens as Record<string, unknown>
            : undefined;

        const accessToken = nonEmpty(
            typeof tokens?.access_token === 'string'
                ? tokens.access_token
                : typeof tokens?.accessToken === 'string'
                    ? tokens.accessToken
                    : undefined
        ) ?? openaiKey;

        if (!accessToken) {
            return null;
        }

        const refreshToken = nonEmpty(
            typeof tokens?.refresh_token === 'string'
                ? tokens.refresh_token
                : typeof tokens?.refreshToken === 'string'
                    ? tokens.refreshToken
                    : undefined
        );
        const accountId = nonEmpty(
            typeof tokens?.account_id === 'string'
                ? tokens.account_id
                : typeof tokens?.accountId === 'string'
                    ? tokens.accountId
                    : undefined
        );
        const idToken = nonEmpty(
            typeof tokens?.id_token === 'string'
                ? tokens.id_token
                : typeof tokens?.idToken === 'string'
                    ? tokens.idToken
                    : undefined
        );
        const lastRefresh = nonEmpty(
            typeof root.last_refresh === 'string'
                ? root.last_refresh
                : typeof root.lastRefresh === 'string'
                    ? root.lastRefresh
                    : undefined
        );

        return {
            accessToken,
            refreshToken,
            accountId,
            idToken,
            lastRefresh
        };
    } catch {
        return null;
    }
}

export function loadCodexCredentials(
    environment: Record<string, string | undefined> = process.env,
    homeDir: string = os.homedir()
): CodexCredentials | null {
    const explicitToken = nonEmpty(environment.CODEX_ACCESS_TOKEN)
        ?? nonEmpty(environment.OPENAI_API_KEY);
    if (explicitToken) {
        return {
            accessToken: explicitToken,
            refreshToken: nonEmpty(environment.CODEX_REFRESH_TOKEN),
            accountId: nonEmpty(environment.CODEX_ACCOUNT_ID)
                ?? nonEmpty(environment.CHATGPT_ACCOUNT_ID)
        };
    }

    try {
        const raw = fs.readFileSync(getCodexAuthFilePath(environment, homeDir), 'utf8');
        return parseCodexAuthJson(raw);
    } catch {
        return null;
    }
}

export function getCodexUsageEndpoint(
    environment: Record<string, string | undefined> = process.env
): URL | null {
    const raw = nonEmpty(environment.CODEX_USAGE_URL) ?? DEFAULT_USAGE_URL;
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || url.username || url.password) {
            return null;
        }
        return url;
    } catch {
        return null;
    }
}

function epochSecondsToIso(epochSeconds: number | undefined): string | undefined {
    if (epochSeconds === undefined || !Number.isFinite(epochSeconds)) {
        return undefined;
    }
    // Accept both seconds and milliseconds.
    const ms = epochSeconds > 1e12 ? epochSeconds : epochSeconds * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function windowUsedPercent(window: WindowSnapshot | null | undefined): number | undefined {
    if (!window) {
        return undefined;
    }
    const raw = window.used_percent ?? window.usedPercent;
    if (raw === undefined || !Number.isFinite(raw)) {
        return undefined;
    }
    return Math.max(0, Math.min(100, raw));
}

function windowResetAt(window: WindowSnapshot | null | undefined): string | undefined {
    if (!window) {
        return undefined;
    }
    return epochSecondsToIso(window.reset_at ?? window.resetAt);
}

/**
 * Map Codex wham/usage windows onto ccstatusline UsageData.
 *
 * Observed shapes:
 * - Plus: only primary_window, and it is the weekly (7d) limit; secondary is null.
 * - Higher plans: primary is the short session window (often 5h), secondary is weekly.
 *
 * Classification uses limit_window_seconds when present; otherwise falls back to
 * "primary alone → weekly" because Plus (the common case) exposes a single weekly primary.
 */
export function parseCodexUsageResponse(rawJson: string): UsageData | null {
    try {
        const parsed = CodexUsageResponseSchema.safeParse(JSON.parse(rawJson));
        if (!parsed.success) {
            return null;
        }

        const rateLimit = parsed.data.rate_limit ?? parsed.data.rateLimit;
        if (!rateLimit) {
            return null;
        }

        const primary = rateLimit.primary_window ?? rateLimit.primaryWindow;
        const secondary = rateLimit.secondary_window ?? rateLimit.secondaryWindow;
        const hasSecondary = secondary != null
            && (windowUsedPercent(secondary) !== undefined || windowResetAt(secondary) !== undefined);

        const primaryDurationSeconds = windowDurationSeconds(primary);
        const secondaryDurationSeconds = windowDurationSeconds(secondary);

        // Dual-window: prefer duration hints; default primary=session, secondary=weekly.
        if (hasSecondary) {
            const primaryIsWeekly = isWeeklyWindowDuration(primaryDurationSeconds)
                && !isSessionWindowDuration(primaryDurationSeconds);
            const secondaryIsSession = isSessionWindowDuration(secondaryDurationSeconds)
                && !isWeeklyWindowDuration(secondaryDurationSeconds);

            if (primaryIsWeekly && secondaryIsSession) {
                return usageDataOrNull({
                    sessionUsage: windowUsedPercent(secondary),
                    sessionResetAt: windowResetAt(secondary),
                    weeklyUsage: windowUsedPercent(primary),
                    weeklyResetAt: windowResetAt(primary)
                });
            }

            return usageDataOrNull({
                sessionUsage: windowUsedPercent(primary),
                sessionResetAt: windowResetAt(primary),
                weeklyUsage: windowUsedPercent(secondary),
                weeklyResetAt: windowResetAt(secondary)
            });
        }

        // Single window: primary is weekly on Plus; only treat as session when duration is clearly short.
        if (isSessionWindowDuration(primaryDurationSeconds) && !isWeeklyWindowDuration(primaryDurationSeconds)) {
            return usageDataOrNull({
                sessionUsage: windowUsedPercent(primary),
                sessionResetAt: windowResetAt(primary)
            });
        }

        return usageDataOrNull({
            weeklyUsage: windowUsedPercent(primary),
            weeklyResetAt: windowResetAt(primary)
        });
    } catch {
        return null;
    }
}

function windowDurationSeconds(window: WindowSnapshot | null | undefined): number | undefined {
    if (!window) {
        return undefined;
    }
    const raw = window.limit_window_seconds ?? window.limitWindowSeconds;
    return raw !== undefined && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function isSessionWindowDuration(seconds: number | undefined): boolean {
    // ~1h–12h: short rolling session / block window (Claude-style 5h is 18000s).
    return seconds !== undefined && seconds >= 3600 && seconds < 12 * 3600;
}

function isWeeklyWindowDuration(seconds: number | undefined): boolean {
    // ~3d–14d: weekly-class limit (Codex Plus primary is 604800s).
    return seconds !== undefined && seconds >= 3 * 86400 && seconds <= 14 * 86400;
}

function usageDataOrNull(usageData: UsageData): UsageData | null {
    return usageData.sessionUsage === undefined && usageData.weeklyUsage === undefined
        ? null
        : usageData;
}

function parseCachedUsage(rawJson: string): UsageData | null {
    try {
        const parsed = CachedCodexUsageSchema.safeParse(JSON.parse(rawJson));
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

/**
 * Session widgets promote weekly when session is absent (SessionUsage).
 * Treat weekly* as satisfying session* for cache completeness so Plus single-window
 * responses do not force a network refresh on every status-line tick.
 */
function isCodexFieldSatisfied(data: UsageData, field: UsageDataField): boolean {
    if (data[field] !== undefined) {
        return true;
    }
    if (field === 'sessionUsage') {
        return data.weeklyUsage !== undefined;
    }
    if (field === 'sessionResetAt') {
        return data.weeklyResetAt !== undefined;
    }
    return false;
}

function hasRequiredFields(data: UsageData, requiredFields: readonly UsageDataField[]): boolean {
    return requiredFields.every(field => isCodexFieldSatisfied(data, field));
}

function hasAnyCodexUsageField(data: UsageData): boolean {
    return (['sessionUsage', 'sessionResetAt', 'weeklyUsage', 'weeklyResetAt'] as const)
        .some(field => data[field] !== undefined);
}

/**
 * Prefer any usable cached fields over a bare error object.
 * Do not attach error onto partial data — several widgets check error before
 * field presence and would show [Timeout] even when weekly usage is available.
 */
function staleUsageOrError(error: UsageError, _requiredFields: readonly UsageDataField[]): UsageData {
    const stale = readCachedUsage();
    if (stale && hasAnyCodexUsageField(stale)) {
        return stale;
    }
    return { error };
}

function readActiveLock(now: number): CodexUsageLock | null {
    try {
        const parsed = CodexUsageLockSchema.safeParse(JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')));
        return parsed.success && parsed.data.blockedUntil > now ? parsed.data : null;
    } catch {
        return null;
    }
}

function writeLock(blockedUntil: number, error: CodexUsageLock['error']): void {
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

function httpsRequest(
    url: URL,
    options: {
        method: string;
        headers: Record<string, string>;
        body?: string;
    }
): Promise<CodexFetchResult> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: CodexFetchResult) => {
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

        const request = https.request(url, {
            method: options.method,
            headers: options.headers,
            timeout: REQUEST_TIMEOUT_MS,
            ...(agent ? { agent } : {})
        }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
                body += chunk;
            });
            response.on('end', () => {
                if (response.statusCode !== undefined
                    && response.statusCode >= 200
                    && response.statusCode < 300
                    && body) {
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
        if (options.body) {
            request.write(options.body);
        }
        request.end();
    });
}

function fetchFromCodexUsageApi(credentials: CodexCredentials, endpoint: URL): Promise<CodexFetchResult> {
    const headers: Record<string, string> = {
        'Accept': 'application/json',
        'Authorization': `Bearer ${credentials.accessToken}`,
        'User-Agent': 'ccstatusline'
    };
    if (credentials.accountId) {
        headers['ChatGPT-Account-Id'] = credentials.accountId;
    }
    return httpsRequest(endpoint, { method: 'GET', headers });
}

const RefreshResponseSchema = z.looseObject({
    access_token: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
    refresh_token: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    id_token: z.string().optional(),
    idToken: z.string().optional()
});

export async function refreshCodexCredentials(
    credentials: CodexCredentials
): Promise<CodexCredentials | null> {
    if (!credentials.refreshToken) {
        return null;
    }

    const body = JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        scope: 'openid profile email'
    });

    const response = await httpsRequest(new URL(REFRESH_URL), {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'ccstatusline'
        },
        body
    });

    if (response.kind !== 'success') {
        return null;
    }

    try {
        const parsed = RefreshResponseSchema.safeParse(JSON.parse(response.body));
        if (!parsed.success) {
            return null;
        }
        const accessToken = nonEmpty(parsed.data.access_token ?? parsed.data.accessToken);
        if (!accessToken) {
            return null;
        }
        return {
            accessToken,
            refreshToken: nonEmpty(parsed.data.refresh_token ?? parsed.data.refreshToken)
                ?? credentials.refreshToken,
            accountId: credentials.accountId,
            idToken: nonEmpty(parsed.data.id_token ?? parsed.data.idToken) ?? credentials.idToken,
            lastRefresh: new Date().toISOString()
        };
    } catch {
        return null;
    }
}

function persistRefreshedCredentials(
    credentials: CodexCredentials,
    environment: Record<string, string | undefined> = process.env,
    homeDir: string = os.homedir()
): void {
    // Only rewrite auth.json when we loaded tokens from disk (not pure env keys).
    if (nonEmpty(environment.CODEX_ACCESS_TOKEN) || nonEmpty(environment.OPENAI_API_KEY)) {
        return;
    }

    const authPath = getCodexAuthFilePath(environment, homeDir);
    try {
        let root: Record<string, unknown> = {};
        try {
            const existing = JSON.parse(fs.readFileSync(authPath, 'utf8')) as unknown;
            if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
                root = existing as Record<string, unknown>;
            }
        } catch {
            // Create a minimal tokens payload when the file is missing or invalid.
        }

        const previousTokens = root.tokens && typeof root.tokens === 'object' && !Array.isArray(root.tokens)
            ? root.tokens as Record<string, unknown>
            : {};

        root.tokens = {
            ...previousTokens,
            access_token: credentials.accessToken,
            ...(credentials.refreshToken ? { refresh_token: credentials.refreshToken } : {}),
            ...(credentials.accountId ? { account_id: credentials.accountId } : {}),
            ...(credentials.idToken ? { id_token: credentials.idToken } : {})
        };
        if (credentials.lastRefresh) {
            root.last_refresh = credentials.lastRefresh;
        }

        fs.writeFileSync(authPath, `${JSON.stringify(root, null, 2)}\n`);
    } catch {
        // Best-effort; usage fetch can still proceed with in-memory tokens.
    }
}

export async function fetchCodexUsageData(options: FetchCodexUsageDataOptions = {}): Promise<UsageData> {
    const requiredFields = (options.requiredFields ?? []).filter(field => CODEX_USAGE_FIELDS.has(field));
    if (options.requiredFields?.length && requiredFields.length === 0) {
        return {};
    }

    const freshCache = readCachedUsage(CACHE_MAX_AGE_SECONDS);
    if (freshCache && hasRequiredFields(freshCache, requiredFields)) {
        return freshCache;
    }

    let credentials = loadCodexCredentials();
    if (!credentials) {
        return staleUsageOrError('no-credentials', requiredFields);
    }

    const endpoint = getCodexUsageEndpoint();
    if (!endpoint) {
        return staleUsageOrError('api-error', requiredFields);
    }

    const now = Math.floor(Date.now() / 1000);
    const activeLock = readActiveLock(now);
    if (activeLock) {
        return staleUsageOrError(activeLock.error, requiredFields);
    }
    writeLock(now + LOCK_MAX_AGE_SECONDS, 'timeout');

    let response = await fetchFromCodexUsageApi(credentials, endpoint);
    if (response.kind === 'auth-error' && credentials.refreshToken) {
        const refreshed = await refreshCodexCredentials(credentials);
        if (refreshed) {
            credentials = refreshed;
            persistRefreshedCredentials(refreshed);
            response = await fetchFromCodexUsageApi(credentials, endpoint);
        }
    }

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

    const usageData = parseCodexUsageResponse(response.body);
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
