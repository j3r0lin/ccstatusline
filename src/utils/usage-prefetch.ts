import type {
    RateLimitPeriod,
    StatusJSON
} from '../types/StatusJSON';
import type { WidgetItem } from '../types/Widget';

import {
    fetchCodexUsageData,
    isCodexUsageContext
} from './codex-usage';
import {
    fetchGrokUsageData,
    isGrokUsageContext
} from './grok-usage';
import {
    fetchKimiUsageData,
    isKimiUsageContext
} from './kimi-usage';
import {
    fetchMagpieUsageData,
    isMagpieGateway,
    resolveSessionAccount
} from './magpie-usage';
import type { UsageData } from './usage';
import {
    ANTHROPIC_USAGE_FIELDS,
    fetchUsageData
} from './usage';
import type { UsageDataField } from './usage-types';
import {
    WEEKLY_MODEL_USAGE_BUCKETS,
    setUsageField
} from './usage-types';

// Non-model usage widgets/fields. The per-model ones (weekly-sonnet-usage,
// weekly-opus-usage, ...) are derived below from WEEKLY_MODEL_USAGE_BUCKETS so
// that adding a model bucket can't desync one of these tables from the others.
const BASE_USAGE_WIDGET_TYPES = [
    'session-usage',
    'weekly-usage',
    'block-timer',
    'monthly-usage',
    'reset-timer',
    'weekly-reset-timer',
    'extra-usage-utilization',
    'extra-usage-remaining',
    'usage-projection',
    'extra-usage-used'
];

const USAGE_WIDGET_TYPES = new Set<string>([
    ...BASE_USAGE_WIDGET_TYPES,
    ...WEEKLY_MODEL_USAGE_BUCKETS.map(bucket => bucket.widgetType)
]);

const USAGE_DATA_FIELDS: UsageDataField[] = [
    'sessionUsage',
    'sessionResetAt',
    'weeklyUsage',
    'weeklyResetAt',
    ...WEEKLY_MODEL_USAGE_BUCKETS.flatMap(bucket => [bucket.usageField, bucket.resetField]),
    'extraUsageEnabled',
    'extraUsageLimit',
    'extraUsageUsed',
    'monthlyUsage',
    'monthlyResetAt',
    'extraUsageUtilization',
    'extraUsageCurrency'
];

interface UsageFieldRequirement {
    alternatives?: UsageDataField[];
    field: UsageDataField;
    suppressFetchError?: boolean;
}

const EMPTY_USAGE_REQUIREMENTS: UsageFieldRequirement[] = [];

const USAGE_WIDGET_REQUIREMENTS: Record<string, UsageFieldRequirement[]> = {
    'session-usage': [{ field: 'sessionUsage' }],
    'usage-projection': [{ field: 'sessionUsage' }, { field: 'sessionResetAt', suppressFetchError: true }],
    // Weekly slots also request the monthly pool, which they render whenever a
    // provider reports one. Providers without monthly data filter these fields
    // out in their fetchers.
    'weekly-usage': [{ field: 'weeklyUsage' }, { field: 'monthlyUsage', suppressFetchError: true }],
    'monthly-usage': [{ field: 'monthlyUsage' }],
    ...Object.fromEntries(WEEKLY_MODEL_USAGE_BUCKETS.map(bucket => [bucket.widgetType, [{ field: bucket.usageField }]])),
    'block-timer': [{ field: 'sessionResetAt', suppressFetchError: true }],
    'reset-timer': [{ field: 'sessionResetAt', suppressFetchError: true }],
    'weekly-reset-timer': [{ field: 'weeklyResetAt', suppressFetchError: true }, { field: 'monthlyResetAt', suppressFetchError: true }],
    'extra-usage-utilization': [
        { field: 'extraUsageEnabled' },
        { field: 'extraUsageUtilization' }
    ],
    'extra-usage-remaining': [
        { field: 'extraUsageEnabled' },
        { field: 'extraUsageLimit' },
        { field: 'extraUsageUsed' }
    ],
    'extra-usage-used': [
        { field: 'extraUsageEnabled' },
        { field: 'extraUsageUsed' }
    ]
};

const USAGE_CURSOR_REQUIREMENTS: Record<string, UsageFieldRequirement> = {
    'session-usage': { field: 'sessionResetAt' },
    'weekly-usage': { field: 'weeklyResetAt' },
    'monthly-usage': { field: 'monthlyResetAt' },
    ...Object.fromEntries(WEEKLY_MODEL_USAGE_BUCKETS.map(bucket => [bucket.widgetType, { field: bucket.resetField, alternatives: ['weeklyResetAt'] }]))
};

export function hasUsageDependentWidgets(lines: WidgetItem[][]): boolean {
    return lines.some(line => line.some(item => USAGE_WIDGET_TYPES.has(item.type)));
}

function isUsageCursorEnabled(item: WidgetItem): boolean {
    return item.metadata?.cursor === 'true';
}

function getUsageFieldRequirements(lines: WidgetItem[][]): UsageFieldRequirement[] {
    const requirements: UsageFieldRequirement[] = [];

    for (const line of lines) {
        for (const item of line) {
            requirements.push(...(USAGE_WIDGET_REQUIREMENTS[item.type] ?? EMPTY_USAGE_REQUIREMENTS));

            const cursorRequirement = USAGE_CURSOR_REQUIREMENTS[item.type];
            if (cursorRequirement && isUsageCursorEnabled(item)) {
                requirements.push(cursorRequirement);
            }
        }
    }

    return requirements;
}

function hasUsageDataField(data: UsageData | null | undefined, field: UsageDataField): boolean {
    return data?.[field] !== undefined;
}

function isUsageRequirementSatisfied(data: UsageData | null, requirement: UsageFieldRequirement): boolean {
    if (hasUsageDataField(data, requirement.field)) {
        return true;
    }

    return requirement.alternatives?.some(field => hasUsageDataField(data, field)) ?? false;
}

function getMissingFetchRequirements(
    data: UsageData | null,
    requirements: UsageFieldRequirement[]
): { fields: UsageDataField[]; suppressFetchError: boolean } {
    const missing = new Set<UsageDataField>();
    let hasUnsuppressedMissingRequirement = false;

    for (const requirement of requirements) {
        if (!isUsageRequirementSatisfied(data, requirement)) {
            missing.add(requirement.field);
            if (!requirement.suppressFetchError) {
                hasUnsuppressedMissingRequirement = true;
            }
        }
    }

    return {
        fields: Array.from(missing),
        suppressFetchError: missing.size > 0 && !hasUnsuppressedMissingRequirement
    };
}

function hasAnyUsageDataField(data: UsageData | null | undefined): boolean {
    return USAGE_DATA_FIELDS.some(field => data?.[field] !== undefined);
}

function pickDefinedUsageFields(data: UsageData | null | undefined): Partial<UsageData> {
    const picked: Partial<UsageData> = {};

    for (const field of USAGE_DATA_FIELDS) {
        const value = data?.[field];
        if (value !== undefined) {
            setUsageField(picked, field, value);
        }
    }

    return picked;
}

function mergeUsageData(rateLimitsData: UsageData | null, apiData: UsageData): UsageData {
    return {
        ...pickDefinedUsageFields(apiData),
        ...pickDefinedUsageFields(rateLimitsData),
        ...(apiData.error ? { error: apiData.error } : {})
    };
}

function epochSecondsToIsoString(epochSeconds: number | null | undefined): string | undefined {
    if (epochSeconds === null || epochSeconds === undefined || !Number.isFinite(epochSeconds)) {
        return undefined;
    }
    return new Date(epochSeconds * 1000).toISOString();
}

// A null legacy per-model bucket is ambiguous: migrated accounts can report it
// alongside an authoritative weekly_scoped API limit. Keep it unset here so
// prefetching checks the API before parseUsageApiResponse applies its legacy
// null-bucket fallback.
function getRateLimitBucketUsage(bucket: RateLimitPeriod | null | undefined): number | undefined {
    return bucket?.used_percentage ?? undefined;
}

export function extractUsageDataFromRateLimits(rateLimits: StatusJSON['rate_limits']): UsageData | null {
    if (!rateLimits) {
        return null;
    }

    // rate_limits is keyed by fixed, schema-declared bucket names (five_hour,
    // seven_day, seven_day_sonnet, ...); WEEKLY_MODEL_USAGE_BUCKETS.apiBucketKey
    // values are those same names, kept in sync via the schema-parity test in
    // usage-fetch.test.ts, so this lookup is safe despite the untyped index.
    const rateLimitBuckets = rateLimits as unknown as Record<string, RateLimitPeriod | null | undefined>;

    const usageData: UsageData = {
        sessionUsage: rateLimits.five_hour?.used_percentage ?? undefined,
        sessionResetAt: epochSecondsToIsoString(rateLimits.five_hour?.resets_at),
        weeklyUsage: rateLimits.seven_day?.used_percentage ?? undefined,
        weeklyResetAt: epochSecondsToIsoString(rateLimits.seven_day?.resets_at)
        // Note: rate_limits does not include extra_usage data (extraUsageEnabled, etc.).
        // Those fields are only available via the API fetch path.
    };

    for (const bucket of WEEKLY_MODEL_USAGE_BUCKETS) {
        if (!bucket.apiBucketKey) {
            continue;
        }

        const rateLimitBucket = rateLimitBuckets[bucket.apiBucketKey];
        setUsageField(usageData, bucket.usageField, getRateLimitBucketUsage(rateLimitBucket));
        setUsageField(usageData, bucket.resetField, epochSecondsToIsoString(rateLimitBucket?.resets_at));
    }

    return hasAnyUsageDataField(usageData) ? usageData : null;
}

export async function prefetchUsageDataIfNeeded(lines: WidgetItem[][], data?: StatusJSON): Promise<UsageData | null> {
    if (!hasUsageDependentWidgets(lines)) {
        return null;
    }

    const requirements = getUsageFieldRequirements(lines);
    // Among the fetchers below, only the Kimi web gateway serves the monthly
    // fields (magpie supplies them in its own branch). The rest ignore them,
    // so don't even ask.
    const nonMonthlyRequirements = requirements.filter(requirement => requirement.field !== 'monthlyUsage' && requirement.field !== 'monthlyResetAt');
    const modelId = typeof data?.model === 'string' ? data.model : data?.model?.id;

    // Through the local gateway the provider is per session, recorded in magpie's
    // affinity file, so a grok-named model can be served by Cursor. The direct
    // Grok, Kimi and Codex fetchers only apply when not behind the gateway.
    if (isMagpieGateway()) {
        const magpieFields = requirements.map(requirement => requirement.field);
        const magpieData = await fetchMagpieUsageData({ requiredFields: magpieFields, sessionId: data?.session_id, modelId });
        // Kimi's membership monthly pool only exists on the Kimi web endpoint;
        // magpie's kimi-code quota has the 5h and 7d windows but not the pool.
        const needsMonthly = requirements.some(requirement => requirement.field === 'monthlyUsage' || requirement.field === 'monthlyResetAt');
        if (needsMonthly && resolveSessionAccount(data?.session_id, modelId)?.provider === 'kimi-code') {
            const monthlyData = await fetchKimiUsageData({ requiredFields: ['monthlyUsage', 'monthlyResetAt'] });
            // magpie's defined fields win; the web pool fills the monthly fields magpie has none of.
            return {
                ...pickDefinedUsageFields({ monthlyUsage: monthlyData.monthlyUsage, monthlyResetAt: monthlyData.monthlyResetAt }),
                ...pickDefinedUsageFields(magpieData),
                ...(magpieData.error ? { error: magpieData.error } : {}),
                localBlockFallback: false
            };
        }
        return { ...magpieData, localBlockFallback: false };
    }

    if (isGrokUsageContext(data)) {
        return fetchGrokUsageData({ requiredFields: nonMonthlyRequirements.map(requirement => requirement.field) });
    }
    if (isKimiUsageContext(data)) {
        return fetchKimiUsageData({ requiredFields: requirements.map(requirement => requirement.field) });
    }
    if (isCodexUsageContext(data)) {
        const codexData = await fetchCodexUsageData({ requiredFields: nonMonthlyRequirements.map(requirement => requirement.field) });
        if (!codexData.error) {
            return codexData;
        }

        return extractUsageDataFromRateLimits(data?.rate_limits) ?? codexData;
    }

    const rateLimitsData = extractUsageDataFromRateLimits(data?.rate_limits);
    // Fields the Anthropic usage API can never provide (e.g. the Kimi monthly
    // pool) must not count as missing here, or every render would refetch.
    const anthropicRequirements = requirements.filter(requirement => ANTHROPIC_USAGE_FIELDS.has(requirement.field));
    const missingRequirements = getMissingFetchRequirements(rateLimitsData, anthropicRequirements);
    const missingFields = missingRequirements.fields;

    if (missingFields.length === 0) {
        return rateLimitsData;
    }

    const apiData = await fetchUsageData({ requiredFields: missingFields });
    if (apiData.error && missingRequirements.suppressFetchError) {
        return rateLimitsData;
    }

    return mergeUsageData(rateLimitsData, apiData);
}
