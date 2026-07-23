import {
    describe,
    expect,
    it
} from 'vitest';

import {
    getGrokAuthFilePath,
    getGrokBillingEndpoint,
    getGrokHomeURL,
    interpretGrokBillingResponse,
    isGrokApiUrl,
    isGrokUsageContext,
    mapGrokBillingToUsageData,
    parseGrokAuthJson,
    parseGrokWebBillingResponse
} from '../grok-usage';

function encodeVarint(value: number | bigint): Buffer {
    let remaining = BigInt(value);
    const bytes: number[] = [];
    while (remaining >= 0x80n) {
        bytes.push(Number((remaining & 0x7fn) | 0x80n));
        remaining >>= 7n;
    }
    bytes.push(Number(remaining));
    return Buffer.from(bytes);
}

function encodeKey(fieldNumber: number, wireType: number): Buffer {
    return encodeVarint((BigInt(fieldNumber) << 3n) | BigInt(wireType));
}

function encodeVarintField(fieldNumber: number, value: number | bigint): Buffer {
    return Buffer.concat([encodeKey(fieldNumber, 0), encodeVarint(value)]);
}

function encodeFixed32Field(fieldNumber: number, value: number): Buffer {
    const payload = Buffer.alloc(4);
    payload.writeFloatLE(value, 0);
    return Buffer.concat([encodeKey(fieldNumber, 5), payload]);
}

function encodeLengthDelimitedField(fieldNumber: number, value: Buffer): Buffer {
    return Buffer.concat([
        encodeKey(fieldNumber, 2),
        encodeVarint(value.length),
        value
    ]);
}

function encodeGrpcWebFrame(payload: Buffer, flags = 0): Buffer {
    const header = Buffer.alloc(5);
    header[0] = flags;
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
}

describe('Grok usage context detection', () => {
    it.each([
        { model: 'grok-code' },
        { model: { id: 'xai/grok-4' } },
        { model: { display_name: 'Grok Build' } }
    ])('detects Grok from the status model', ({ model }) => {
        expect(isGrokUsageContext({ model }, {})).toBe(true);
    });

    it('detects Grok from the configured API host when status model is absent', () => {
        expect(isGrokUsageContext(
            {},
            { ANTHROPIC_BASE_URL: 'https://api.x.ai/v1' }
        )).toBe(true);
    });

    it('detects Grok from configured model env vars when status model is absent', () => {
        expect(isGrokUsageContext(
            {},
            { ANTHROPIC_MODEL: 'grok-code-fast-1' }
        )).toBe(true);
    });

    it('does not classify an Anthropic model as Grok even when env points at Grok', () => {
        expect(isGrokUsageContext(
            { model: { id: 'claude-sonnet-4-5' } },
            {
                ANTHROPIC_MODEL: 'grok-4.5',
                ANTHROPIC_BASE_URL: 'https://api.x.ai/v1'
            }
        )).toBe(false);
    });

    it('recognizes xAI and grok.com hosts', () => {
        expect(isGrokApiUrl('https://api.x.ai/v1')).toBe(true);
        expect(isGrokApiUrl('https://grok.com')).toBe(true);
        expect(isGrokApiUrl('https://api.anthropic.com')).toBe(false);
    });
});

describe('Grok auth parsing', () => {
    it('prefers the SuperGrok OIDC scope entry and rejects expired tokens', () => {
        const valid = parseGrokAuthJson(JSON.stringify({
            'https://accounts.x.ai/sign-in': {
                key: 'legacy-token',
                expires_at: '2030-01-01T00:00:00Z'
            },
            'https://auth.x.ai::client-id': {
                key: 'oidc-token',
                expires_at: '2030-01-01T00:00:00Z',
                principal_type: 'User',
                email: 'user@example.com',
                team_id: 'team-1'
            }
        }), new Date('2026-07-23T00:00:00Z'));

        expect(valid).toEqual({
            accessToken: 'oidc-token',
            expiresAt: new Date('2030-01-01T00:00:00Z'),
            principalType: 'User',
            email: 'user@example.com',
            teamId: 'team-1'
        });

        expect(parseGrokAuthJson(JSON.stringify({
            'https://auth.x.ai::client-id': {
                key: 'oidc-token',
                expires_at: '2020-01-01T00:00:00Z'
            }
        }), new Date('2026-07-23T00:00:00Z'))).toBeNull();
    });

    it('resolves GROK_HOME and auth path', () => {
        expect(getGrokHomeURL({ GROK_HOME: '/tmp/custom-grok' }, '/Users/me')).toBe('/tmp/custom-grok');
        expect(getGrokAuthFilePath({}, '/Users/me')).toBe('/Users/me/.grok/auth.json');
    });
});

describe('Grok billing endpoint', () => {
    it('uses the official endpoint by default', () => {
        expect(getGrokBillingEndpoint({})?.toString())
            .toBe('https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig');
    });

    it('accepts HTTPS overrides and rejects insecure ones', () => {
        expect(getGrokBillingEndpoint({ GROK_BILLING_URL: 'https://proxy.example.com/grok-billing' })?.toString())
            .toBe('https://proxy.example.com/grok-billing');
        expect(getGrokBillingEndpoint({ GROK_BILLING_URL: 'http://grok.com/billing' })).toBeNull();
    });
});

describe('Grok web billing protobuf parsing', () => {
    it('maps credit usage percent and reset timestamp into weekly usage fields', () => {
        const nested = Buffer.concat([
            encodeFixed32Field(1, 37.5),
            encodeLengthDelimitedField(5, encodeVarintField(1, 2_000_000_000)),
            encodeLengthDelimitedField(6, encodeVarintField(1, 1))
        ]);
        const payload = encodeLengthDelimitedField(1, nested);
        const frame = encodeGrpcWebFrame(payload);

        const snapshot = parseGrokWebBillingResponse(frame, new Date('2026-07-23T00:00:00Z'));
        expect(snapshot).toEqual({
            usedPercent: 37.5,
            resetsAt: new Date(2_000_000_000 * 1000).toISOString()
        });
        expect(snapshot && mapGrokBillingToUsageData(snapshot)).toEqual({
            weeklyUsage: 37.5,
            weeklyResetAt: new Date(2_000_000_000 * 1000).toISOString()
        });
    });

    it('treats an active period with omitted percent as zero usage', () => {
        const nested = Buffer.concat([
            encodeLengthDelimitedField(5, encodeVarintField(1, 2_000_000_000)),
            encodeLengthDelimitedField(6, encodeVarintField(1, 1))
        ]);
        const payload = encodeLengthDelimitedField(1, nested);

        expect(parseGrokWebBillingResponse(payload, new Date('2026-07-23T00:00:00Z'))).toEqual({
            usedPercent: 0,
            resetsAt: new Date(2_000_000_000 * 1000).toISOString()
        });
    });

    it('rejects payloads without recoverable usage', () => {
        expect(parseGrokWebBillingResponse(Buffer.from([0x00, 0x01, 0x02]))).toBeNull();
    });

    it('classifies grpc auth failures and team-unsupported responses', () => {
        const body = encodeGrpcWebFrame(Buffer.from('grpc-status:16\r\ngrpc-message:unauthenticated\r\n'), 0x80);
        expect(interpretGrokBillingResponse(body, {}, {
            accessToken: 'token',
            principalType: 'User'
        })).toEqual({ kind: 'auth-error' });

        const teamBody = encodeGrpcWebFrame(Buffer.from('grpc-status:9\r\ngrpc-message:no personal team\r\n'), 0x80);
        expect(interpretGrokBillingResponse(teamBody, {}, {
            accessToken: 'token',
            principalType: 'team'
        })).toEqual({ kind: 'team-unsupported' });
    });
});
