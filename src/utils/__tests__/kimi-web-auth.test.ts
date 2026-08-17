import { pbkdf2Sync } from 'crypto';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    decryptChromiumCookieValue,
    isKimiJwtUsable
} from '../kimi-web-auth';

// Known-answer vectors: key = PBKDF2-HMAC-SHA1('test-password', 'saltysalt',
// 1003, 16), AES-128-CBC with the Chromium IV (16 spaces), 'v10' prefix.
const TEST_KEY = pbkdf2Sync('test-password', 'saltysalt', 1003, 16, 'sha1');
const TEST_HOST = 'www.kimi.com';
const TEST_VALUE = 'fake-jwt-token';
const DB_V24_CIPHERTEXT = Buffer.from(
    '763130e727bcfbe10bea9e1a870dfefed9ec290e1db2c877250319c82328868dd4b89a715f3d72c45244d141d95a8714a03785',
    'hex'
);
const LEGACY_CIPHERTEXT = Buffer.from('7631300acbcdfee15342987068774100bcef7b', 'hex');

function makeJwt(expSeconds: number): string {
    const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
    return `header.${payload}.signature`;
}

describe('decryptChromiumCookieValue', () => {
    it('decrypts a v24 cookie value and strips the SHA-256 host prefix', () => {
        expect(decryptChromiumCookieValue(DB_V24_CIPHERTEXT, TEST_KEY, TEST_HOST)).toBe(TEST_VALUE);
    });

    it('decrypts a legacy cookie value without a host prefix', () => {
        expect(decryptChromiumCookieValue(LEGACY_CIPHERTEXT, TEST_KEY, TEST_HOST)).toBe(TEST_VALUE);
    });

    it('rejects values without the v10 prefix', () => {
        expect(decryptChromiumCookieValue(Buffer.from('plain-value'), TEST_KEY, TEST_HOST)).toBeNull();
    });

    it('rejects undecryptable values', () => {
        const wrongKey = Buffer.alloc(16, 0);
        expect(decryptChromiumCookieValue(DB_V24_CIPHERTEXT, wrongKey, TEST_HOST)).toBeNull();
    });
});

describe('isKimiJwtUsable', () => {
    it('accepts a token expiring beyond the grace window', () => {
        const nowMs = Date.parse('2026-08-17T00:00:00Z');
        expect(isKimiJwtUsable(makeJwt(Date.parse('2026-08-21T00:00:00Z') / 1000), nowMs)).toBe(true);
    });

    it('rejects an expired token', () => {
        const nowMs = Date.parse('2026-08-17T00:00:00Z');
        expect(isKimiJwtUsable(makeJwt(Date.parse('2026-08-01T00:00:00Z') / 1000), nowMs)).toBe(false);
    });

    it('rejects malformed tokens', () => {
        expect(isKimiJwtUsable('not-a-jwt')).toBe(false);
        expect(isKimiJwtUsable('')).toBe(false);
    });
});
