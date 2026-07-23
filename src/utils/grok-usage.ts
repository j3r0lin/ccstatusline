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
const DEFAULT_BILLING_ENDPOINT = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
const OIDC_SCOPE_PREFIX = 'https://auth.x.ai::';
const LEGACY_SESSION_SCOPE = 'https://accounts.x.ai/sign-in';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'ccstatusline');
const CACHE_FILE = path.join(CACHE_DIR, 'grok-usage.json');
const LOCK_FILE = path.join(CACHE_DIR, 'grok-usage.lock');
const EMPTY_GRPC_WEB_FRAME = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]);

type UsageDataField = Exclude<keyof UsageData, 'error'>;

export interface FetchGrokUsageDataOptions { requiredFields?: readonly UsageDataField[] }

export interface GrokCredentials {
    accessToken: string;
    expiresAt?: Date;
    principalType?: string;
    email?: string;
    teamId?: string;
}

export interface GrokWebBillingSnapshot {
    usedPercent: number;
    resetsAt?: string;
}

const GROK_USAGE_FIELDS = new Set<UsageDataField>([
    'weeklyUsage',
    'weeklyResetAt'
]);

const CachedGrokUsageSchema = z.looseObject({
    weeklyUsage: z.number().optional(),
    weeklyResetAt: z.string().optional()
});

const GrokUsageLockSchema = z.object({
    blockedUntil: z.number(),
    error: z.enum(['timeout', 'rate-limited', 'api-error', 'parse-error'])
});

const GrokAuthEntrySchema = z.looseObject({
    key: z.string().min(1),
    expires_at: z.string().nullable().optional(),
    principal_type: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    team_id: z.string().nullable().optional()
});

type GrokUsageLock = z.infer<typeof GrokUsageLockSchema>;
type GrokFetchResult
    = | { kind: 'success'; body: Buffer; headers: Record<string, string | string[] | undefined> }
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

function isGrokModelIdentifier(value: string | undefined): boolean {
    return Boolean(value?.toLowerCase().includes('grok'));
}

export function isGrokApiUrl(rawUrl: string | undefined): boolean {
    if (!rawUrl?.trim()) {
        return false;
    }

    try {
        const hostname = new URL(rawUrl).hostname.toLowerCase();
        return hostname === 'x.ai'
            || hostname.endsWith('.x.ai')
            || hostname === 'grok.com'
            || hostname.endsWith('.grok.com');
    } catch {
        return false;
    }
}

export function isGrokUsageContext(
    data: StatusJSON | undefined,
    environment: Record<string, string | undefined> = process.env
): boolean {
    const modelIdentifiers = getModelIdentifiers(data?.model);
    if (modelIdentifiers.length > 0) {
        return modelIdentifiers.some(isGrokModelIdentifier);
    }

    const configuredModels = [
        environment.ANTHROPIC_MODEL,
        environment.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        environment.ANTHROPIC_DEFAULT_SONNET_MODEL,
        environment.ANTHROPIC_DEFAULT_OPUS_MODEL
    ];
    if (configuredModels.some(isGrokModelIdentifier)) {
        return true;
    }

    return isGrokApiUrl(environment.ANTHROPIC_BASE_URL);
}

export function getGrokHomeURL(
    environment: Record<string, string | undefined> = process.env,
    homeDir: string = os.homedir()
): string {
    const custom = nonEmpty(environment.GROK_HOME);
    if (custom) {
        return path.resolve(custom.startsWith('~')
            ? custom.replace(/^~(?=$|[/\\])/, homeDir)
            : custom);
    }

    return path.join(homeDir, '.grok');
}

export function getGrokAuthFilePath(
    environment: Record<string, string | undefined> = process.env,
    homeDir: string = os.homedir()
): string {
    return path.join(getGrokHomeURL(environment, homeDir), 'auth.json');
}

function selectPreferredAuthEntry(root: Record<string, unknown>): unknown {
    const oidcEntries = Object.entries(root)
        .filter(([scope, value]) => scope.startsWith(OIDC_SCOPE_PREFIX) && value && typeof value === 'object')
        .map(([, value]) => value);
    if (oidcEntries[0]) {
        return oidcEntries[0];
    }

    return root[LEGACY_SESSION_SCOPE];
}

export function parseGrokAuthJson(rawJson: string, now: Date = new Date()): GrokCredentials | null {
    try {
        const parsed = JSON.parse(rawJson) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }

        const entry = selectPreferredAuthEntry(parsed as Record<string, unknown>);
        const auth = GrokAuthEntrySchema.safeParse(entry);
        if (!auth.success) {
            return null;
        }

        const expiresAtRaw = nonEmpty(auth.data.expires_at);
        const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : undefined;
        if (expiresAt && Number.isNaN(expiresAt.getTime())) {
            return null;
        }
        if (expiresAt && now >= expiresAt) {
            return null;
        }

        return {
            accessToken: auth.data.key,
            expiresAt,
            principalType: nonEmpty(auth.data.principal_type),
            email: nonEmpty(auth.data.email),
            teamId: nonEmpty(auth.data.team_id)
        };
    } catch {
        return null;
    }
}

export function loadGrokCredentials(
    environment: Record<string, string | undefined> = process.env,
    homeDir: string = os.homedir(),
    now: Date = new Date()
): GrokCredentials | null {
    const explicitToken = nonEmpty(environment.GROK_ACCESS_TOKEN);
    if (explicitToken) {
        return { accessToken: explicitToken };
    }

    try {
        const raw = fs.readFileSync(getGrokAuthFilePath(environment, homeDir), 'utf8');
        return parseGrokAuthJson(raw, now);
    } catch {
        return null;
    }
}

export function getGrokBillingEndpoint(
    environment: Record<string, string | undefined> = process.env
): URL | null {
    const raw = nonEmpty(environment.GROK_BILLING_URL) ?? DEFAULT_BILLING_ENDPOINT;
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

function headerMap(headers: NodeJS.Dict<string | string[] | undefined>): Record<string, string | string[] | undefined> {
    return headers;
}

function normalizeHeaderValue(value: string | string[] | undefined): string {
    const raw = Array.isArray(value) ? value.join(',') : value ?? '';
    return raw.trim();
}

function grpcHeaderFields(headers: Record<string, string | string[] | undefined>): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        const normalizedKey = key.trim().toLowerCase();
        if (!normalizedKey.startsWith('grpc-')) {
            continue;
        }
        fields[normalizedKey] = decodeURIComponent(normalizeHeaderValue(value));
    }
    return fields;
}

function grpcWebTrailerFields(data: Buffer): Record<string, string> {
    const fields: Record<string, string> = {};
    let index = 0;
    while (index + 5 <= data.length) {
        const flags = data[index] ?? 0;
        const length = data.readUInt32BE(index + 1);
        const start = index + 5;
        const end = start + length;
        if (length < 0 || end > data.length) {
            break;
        }
        if ((flags & 0x80) !== 0) {
            const text = data.subarray(start, end).toString('utf8');
            for (const line of text.split(/\r?\n/)) {
                if (!line) {
                    continue;
                }
                const separator = line.indexOf(':');
                if (separator < 0) {
                    continue;
                }
                const key = line.slice(0, separator).trim().toLowerCase();
                const value = decodeURIComponent(line.slice(separator + 1).trim());
                fields[key] = value;
            }
        }
        index = end;
    }
    return fields;
}

function validateGrpcStatusFields(fields: Record<string, string>): void {
    const rawStatus = fields['grpc-status'];
    if (!rawStatus) {
        return;
    }
    const status = Number.parseInt(rawStatus, 10);
    if (!Number.isFinite(status) || status === 0) {
        return;
    }
    throw Object.assign(new Error(fields['grpc-message'] ?? ''), {
        name: 'GrokGrpcError',
        status,
        messageText: fields['grpc-message'] ?? ''
    });
}

function looksLikeProtobufPayload(data: Buffer): boolean {
    if (data.length === 0) {
        return false;
    }
    const first = data[0] ?? 0;
    const fieldNumber = first >> 3;
    const wireType = first & 0x07;
    return fieldNumber > 0 && (wireType === 0 || wireType === 1 || wireType === 2 || wireType === 5);
}

function grpcWebDataFrames(data: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    let index = 0;
    while (index < data.length) {
        if (index + 5 > data.length) {
            return [];
        }
        const flags = data[index] ?? 0;
        const length = data.readUInt32BE(index + 1);
        const start = index + 5;
        const end = start + length;
        if (length < 0 || end > data.length) {
            return [];
        }
        if ((flags & 0x80) === 0) {
            frames.push(data.subarray(start, end));
        }
        index = end;
    }
    return frames;
}

interface Fixed32Field {
    path: number[];
    value: number;
    order: number;
}

interface VarintField {
    path: number[];
    value: bigint;
}

interface ProtobufScan {
    fixed32Fields: Fixed32Field[];
    varintFields: VarintField[];
}

function readVarint(bytes: Buffer, index: { value: number }): bigint | null {
    let value = 0n;
    let shift = 0n;
    while (index.value < bytes.length && shift < 64n) {
        const byte = BigInt(bytes[index.value] ?? 0);
        index.value += 1;
        value |= (byte & 0x7fn) << shift;
        if ((byte & 0x80n) === 0n) {
            return value;
        }
        shift += 7n;
    }
    return null;
}

function scanProtobuf(data: Buffer, depth: number, path: number[] = [], order = 0): { scan: ProtobufScan; order: number } {
    const bytes = data;
    const scan: ProtobufScan = { fixed32Fields: [], varintFields: [] };
    const index = { value: 0 };
    let nextOrder = order;

    while (index.value < bytes.length) {
        const fieldStart = index.value;
        const key = readVarint(bytes, index);
        if (key === null || key === 0n) {
            index.value = fieldStart + 1;
            continue;
        }

        const fieldNumber = Number(key >> 3n);
        const wireType = Number(key & 0x7n);
        const fieldPath = [...path, fieldNumber];

        switch (wireType) {
            case 0: {
                const value = readVarint(bytes, index);
                if (value === null) {
                    index.value = fieldStart + 1;
                    break;
                }
                scan.varintFields.push({ path: fieldPath, value });
                break;
            }
            case 1: {
                if (index.value + 8 > bytes.length) {
                    return { scan, order: nextOrder };
                }
                index.value += 8;
                break;
            }
            case 2: {
                const length = readVarint(bytes, index);
                if (length === null || length > BigInt(bytes.length - index.value)) {
                    index.value = fieldStart + 1;
                    break;
                }
                const start = index.value;
                const end = index.value + Number(length);
                if (depth < 4) {
                    const nested = scanProtobuf(bytes.subarray(start, end), depth + 1, fieldPath, nextOrder);
                    scan.fixed32Fields.push(...nested.scan.fixed32Fields);
                    scan.varintFields.push(...nested.scan.varintFields);
                    nextOrder = nested.order;
                }
                index.value = end;
                break;
            }
            case 5: {
                if (index.value + 4 > bytes.length) {
                    return { scan, order: nextOrder };
                }
                const value = bytes.readFloatLE(index.value);
                scan.fixed32Fields.push({
                    path: fieldPath,
                    value,
                    order: nextOrder
                });
                nextOrder += 1;
                index.value += 4;
                break;
            }
            default:
                index.value = fieldStart + 1;
                break;
        }
    }

    return { scan, order: nextOrder };
}

function pathEquals(left: number[], right: number[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function pathStartsWith(pathValue: number[], prefix: number[]): boolean {
    return prefix.every((value, index) => pathValue[index] === value);
}

export function parseGrokWebBillingResponse(data: Buffer, now: Date = new Date()): GrokWebBillingSnapshot | null {
    let payloads = grpcWebDataFrames(data);
    if (payloads.length === 0 && looksLikeProtobufPayload(data)) {
        payloads = [data];
    }
    if (payloads.length === 0) {
        return null;
    }

    const scan: ProtobufScan = { fixed32Fields: [], varintFields: [] };
    for (const payload of payloads) {
        const nested = scanProtobuf(payload, 0);
        scan.fixed32Fields.push(...nested.scan.fixed32Fields);
        scan.varintFields.push(...nested.scan.varintFields);
    }

    const percentCandidates = scan.fixed32Fields
        .filter((field) => {
            const last = field.path[field.path.length - 1];
            return last === 1
                && Number.isFinite(field.value)
                && field.value >= 0
                && field.value <= 100;
        })
        .sort((left, right) => {
            if (left.path.length !== right.path.length) {
                return left.path.length - right.path.length;
            }
            return left.order - right.order;
        });
    const parsedPercent = percentCandidates[0]?.value;

    const resetFields = scan.varintFields.flatMap((field) => {
        if (field.value < 1_700_000_000n || field.value > 2_100_000_000n) {
            return [];
        }
        return [{
            path: field.path,
            date: new Date(Number(field.value) * 1000)
        }];
    });
    const futureResetFields = resetFields.filter(field => field.date.getTime() > now.getTime());
    const preferredReset = futureResetFields.find(field => pathEquals(field.path, [1, 5, 1]))?.date
        ?? futureResetFields
            .map(field => field.date)
            .sort((left, right) => left.getTime() - right.getTime())[0];

    const hasUsagePeriod = scan.varintFields.some(field => (
        pathStartsWith(field.path, [1, 6])
        || (pathEquals(field.path, [1, 8, 1]) && (field.value === 1n || field.value === 2n))
    ));
    const noUsageYet = parsedPercent === undefined
        && scan.fixed32Fields.length === 0
        && preferredReset !== undefined
        && hasUsagePeriod;

    const percent = parsedPercent ?? (noUsageYet ? 0 : undefined);
    if (percent === undefined || !Number.isFinite(percent)) {
        return null;
    }

    return {
        usedPercent: Math.max(0, Math.min(100, percent)),
        resetsAt: preferredReset?.toISOString()
    };
}

export function mapGrokBillingToUsageData(snapshot: GrokWebBillingSnapshot): UsageData {
    return {
        weeklyUsage: snapshot.usedPercent,
        weeklyResetAt: snapshot.resetsAt
    };
}

function isTeamPrincipal(credentials: GrokCredentials | null | undefined): boolean {
    return credentials?.principalType?.trim().toLowerCase() === 'team';
}

function isTeamBillingUnavailable(status: number, message: string): boolean {
    if (status !== 9) {
        return false;
    }
    const normalized = message.trim().toLowerCase();
    return normalized === 'no personal team' || normalized === 'no personal team.';
}

function isAuthenticationFailure(status: number, message: string): boolean {
    if (status === 16) {
        return true;
    }
    if (status !== 7) {
        return false;
    }
    const lower = message.toLowerCase();
    return lower.includes('bad-credentials')
        || lower.includes('unauthenticated')
        || (lower.includes('oauth2') && lower.includes('could not be validated'))
        || (lower.includes('access token')
            && (lower.includes('invalid') || lower.includes('expired') || lower.includes('could not be validated')));
}

export function interpretGrokBillingResponse(
    body: Buffer,
    headers: Record<string, string | string[] | undefined>,
    credentials?: GrokCredentials | null,
    now: Date = new Date()
): { kind: 'success'; data: UsageData }
    | { kind: 'auth-error' }
    | { kind: 'team-unsupported' }
    | { kind: 'parse-error' }
    | { kind: 'api-error' } {
    try {
        validateGrpcStatusFields(grpcHeaderFields(headers));
        validateGrpcStatusFields(grpcWebTrailerFields(body));
    } catch (error) {
        const status = typeof error === 'object' && error && 'status' in error
            ? Number((error as { status?: number }).status)
            : NaN;
        const messageText = typeof error === 'object' && error && 'messageText' in error
            ? (error as { messageText?: unknown }).messageText
            : undefined;
        const message = typeof messageText === 'string'
            ? messageText
            : error instanceof Error ? error.message : '';

        if (Number.isFinite(status) && isAuthenticationFailure(status, message)) {
            return { kind: 'auth-error' };
        }
        if (Number.isFinite(status)
            && isTeamPrincipal(credentials)
            && isTeamBillingUnavailable(status, message)) {
            return { kind: 'team-unsupported' };
        }
        return { kind: 'api-error' };
    }

    const snapshot = parseGrokWebBillingResponse(body, now);
    if (!snapshot) {
        return { kind: 'parse-error' };
    }
    return { kind: 'success', data: mapGrokBillingToUsageData(snapshot) };
}

function parseCachedUsage(rawJson: string): UsageData | null {
    try {
        const parsed = CachedGrokUsageSchema.safeParse(JSON.parse(rawJson));
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

function readActiveLock(now: number): GrokUsageLock | null {
    try {
        const parsed = GrokUsageLockSchema.safeParse(JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')));
        return parsed.success && parsed.data.blockedUntil > now ? parsed.data : null;
    } catch {
        return null;
    }
}

function writeLock(blockedUntil: number, error: GrokUsageLock['error']): void {
    try {
        ensureCacheDirExists();
        fs.writeFileSync(LOCK_FILE, JSON.stringify({ blockedUntil, error }));
    } catch {
        // Cache coordination is best-effort.
    }
}

function fetchFromGrokBilling(accessToken: string, endpoint: URL): Promise<GrokFetchResult> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: GrokFetchResult) => {
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
            method: 'POST',
            headers: {
                'Accept': '*/*',
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/grpc-web+proto',
                'Content-Length': String(EMPTY_GRPC_WEB_FRAME.length),
                'Origin': 'https://grok.com',
                'Referer': 'https://grok.com/?_s=usage',
                'User-Agent': 'ccstatusline',
                'x-grpc-web': '1',
                'x-user-agent': 'connect-es/2.1.1'
            },
            timeout: REQUEST_TIMEOUT_MS,
            ...(agent ? { agent } : {})
        }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer | string) => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            response.on('end', () => {
                const body = Buffer.concat(chunks);
                if (response.statusCode === 200 && body.length > 0) {
                    finish({ kind: 'success', body, headers: headerMap(response.headers) });
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
        request.write(EMPTY_GRPC_WEB_FRAME);
        request.end();
    });
}

export async function fetchGrokUsageData(options: FetchGrokUsageDataOptions = {}): Promise<UsageData> {
    const requiredFields = (options.requiredFields ?? []).filter(field => GROK_USAGE_FIELDS.has(field));
    if (options.requiredFields?.length && requiredFields.length === 0) {
        return {};
    }

    const freshCache = readCachedUsage(CACHE_MAX_AGE_SECONDS);
    if (freshCache && hasRequiredFields(freshCache, requiredFields)) {
        return freshCache;
    }

    const credentials = loadGrokCredentials();
    if (!credentials) {
        return staleUsageOrError('no-credentials', requiredFields);
    }

    const endpoint = getGrokBillingEndpoint();
    if (!endpoint) {
        return staleUsageOrError('api-error', requiredFields);
    }

    const now = Math.floor(Date.now() / 1000);
    const activeLock = readActiveLock(now);
    if (activeLock) {
        return staleUsageOrError(activeLock.error, requiredFields);
    }
    writeLock(now + LOCK_MAX_AGE_SECONDS, 'timeout');

    const response = await fetchFromGrokBilling(credentials.accessToken, endpoint);
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

    const interpreted = interpretGrokBillingResponse(response.body, response.headers, credentials);
    if (interpreted.kind === 'auth-error') {
        return staleUsageOrError('no-credentials', requiredFields);
    }
    if (interpreted.kind === 'team-unsupported' || interpreted.kind === 'api-error') {
        return staleUsageOrError('api-error', requiredFields);
    }
    if (interpreted.kind === 'parse-error') {
        writeLock(now + LOCK_MAX_AGE_SECONDS, 'parse-error');
        return staleUsageOrError('parse-error', requiredFields);
    }

    const usageData = interpreted.data;
    try {
        ensureCacheDirExists();
        fs.writeFileSync(CACHE_FILE, JSON.stringify(usageData));
    } catch {
        // Cache writes are best-effort.
    }
    return usageData;
}
