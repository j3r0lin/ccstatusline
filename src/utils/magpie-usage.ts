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
}

const MAGPIE_USAGE_FIELDS = new Set<UsageDataField>([
    'sessionUsage',
    'sessionResetAt',
    'weeklyUsage',
    'weeklyResetAt',
    'fableUsage',
    'fableResetAt'
]);

const QuotaWindowSchema = z.looseObject({
    name: z.string(),
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
// no vendor, so the served provider is resolved per session. Callers check the
// Grok, Kimi and Codex model names first.
export function isMagpieUsageContext(
    data: StatusJSON | undefined,
    environment: Record<string, string | undefined> = process.env
): boolean {
    return isMagpieGateway(environment) && getModelIdentifiers(data?.model).length > 0;
}

function findWindow(windows: readonly QuotaWindow[], name: string): QuotaWindow | undefined {
    return windows.find(window => window.name.trim().toLowerCase() === name);
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
    email: string;
    // True when the session's model is a routing group (e.g. sonnet-tier) whose
    // provider varies per session.
    routed?: boolean;
}

function pickAccount(entries: readonly QuotaEntry[], account: MagpieAccount): QuotaEntry | undefined {
    return entries.find(entry => entry.provider === account.provider && accountEmail(entry.user) === account.email);
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
        const entries = Object.entries(JSON.parse(fs.readFileSync(affinityFile, 'utf8')) as Record<string, { who?: string; at?: string }>);
        // Claude Code reports a routing group as "group/sonnet-tier", which is already the affinity key's prefix and name.
        const bareModelId = modelId.replace(/^group\//, '');
        const latest = entries
            .filter(([key, value]) => key === `${key.split('/')[0]}/${bareModelId}|${sessionId}` && typeof value.who === 'string')
            .sort(([, left], [, right]) => Date.parse(right.at ?? '') - Date.parse(left.at ?? ''))[0];
        // `who` looks like "claude@platform2@inhand.com · inhand" or "codex@someone@gmail.com".
        const who = latest?.[1].who ?? '';
        const separator = who.indexOf('@');
        const email = separator > 0 ? accountEmail(who.slice(separator + 1)) : undefined;
        return email ? { provider: who.slice(0, separator), email, routed: latest?.[0].startsWith('group/') } : undefined;
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

        const windows = pickAccount(parsed.data.data, account)?.windows ?? [];
        const session = toUsageFields(findWindow(windows, '5 hours'));
        const weekly = toUsageFields(findWindow(windows, '7 days'));
        const fable = toUsageFields(findWindow(windows, '7 days · fable'));

        const usageData: UsageData = {
            sessionUsage: session.usage,
            sessionResetAt: session.resetAt,
            weeklyUsage: weekly.usage,
            weeklyResetAt: weekly.resetAt,
            fableUsage: fable.usage,
            fableResetAt: fable.resetAt
        };

        return Object.values(usageData).some(value => value !== undefined) ? usageData : null;
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
function writeCachedBody(body: string): void {
    const tempFile = `${CACHE_FILE}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(tempFile, body);
        fs.renameSync(tempFile, CACHE_FILE);
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
    const account = resolveSessionAccount(options.sessionId, options.modelId, environment);
    if (!account) {
        return {};
    }

    const freshBody = readCachedBody(FRESH_MAX_AGE_SECONDS);
    const freshUsage = freshBody ? parseMagpieQuotaResponse(freshBody, account) : null;
    if (freshUsage) {
        return freshUsage;
    }

    const response = await getFromGateway(new URL('/v1/magpie/quotas', gateway.origin));
    if (response.kind !== 'success') {
        return usageFromBodyOrError(readCachedBody(STALE_MAX_AGE_SECONDS), account, response.kind === 'timeout' ? 'timeout' : 'api-error');
    }

    const usageData = parseMagpieQuotaResponse(response.body, account);
    if (!usageData) {
        return { error: 'parse-error' };
    }

    writeCachedBody(response.body);
    return usageData;
}
