import { pbkdf2Sync } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    decryptChromiumCookieValue,
    isKimiJwtUsable,
    readKimiWebAuthSessionFromLevelDb,
    resolveKimiWebAuthSession
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

function encodeVarint(value: number): Buffer {
    const bytes: number[] = [];
    let remaining = value;
    do {
        let byte = remaining % 128;
        remaining = Math.floor(remaining / 128);
        if (remaining > 0) {
            byte |= 0x80;
        }
        bytes.push(byte);
    } while (remaining > 0);
    return Buffer.from(bytes);
}

function chromiumString(value: string): Buffer {
    return Buffer.concat([Buffer.from([1]), Buffer.from(value, 'latin1')]);
}

function writeLevelDbLog(
    directory: string,
    values: Record<string, string>,
    fileName = '000001.log',
    firstSequence = 100n
): void {
    const entries = Object.entries(values).map(([key, value]) => {
        const recordKey = Buffer.concat([
            Buffer.from('_https://www.kimi.com\0', 'latin1'),
            chromiumString(key)
        ]);
        const recordValue = chromiumString(value);
        return Buffer.concat([
            Buffer.from([1]),
            encodeVarint(recordKey.length),
            recordKey,
            encodeVarint(recordValue.length),
            recordValue
        ]);
    });
    const batchHeader = Buffer.alloc(12);
    batchHeader.writeBigUInt64LE(firstSequence, 0);
    batchHeader.writeUInt32LE(entries.length, 8);
    const batch = Buffer.concat([batchHeader, ...entries]);
    const logHeader = Buffer.alloc(7);
    logHeader.writeUInt16LE(batch.length, 4);
    logHeader[6] = 1;
    fs.writeFileSync(path.join(directory, fileName), Buffer.concat([logHeader, batch]));
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

describe('Chromium Local Storage auth', () => {
    it('reads access_token and refresh_token from a LevelDB log', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-kimi-auth-test-'));
        try {
            writeLevelDbLog(directory, {
                access_token: 'fake-access-token',
                refresh_token: 'fake-refresh-token',
                unrelated: 'ignored'
            });

            expect(readKimiWebAuthSessionFromLevelDb(directory)).toEqual({
                accessToken: 'fake-access-token',
                refreshToken: 'fake-refresh-token'
            });
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('selects the highest sequence across all LevelDB files', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-kimi-auth-test-'));
        try {
            writeLevelDbLog(directory, {
                access_token: 'new-access-token',
                refresh_token: 'new-refresh-token'
            }, '000001.log', 200n);
            writeLevelDbLog(directory, {
                access_token: 'old-access-token',
                refresh_token: 'old-refresh-token'
            }, '000002.log', 100n);

            expect(readKimiWebAuthSessionFromLevelDb(directory)).toEqual({
                accessToken: 'new-access-token',
                refreshToken: 'new-refresh-token'
            });
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('continues past an expired access-only profile to a refreshable profile', () => {
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-kimi-home-test-'));
        const chromeRoot = path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome');
        const defaultLevelDb = path.join(chromeRoot, 'Default', 'Local Storage', 'leveldb');
        const profileLevelDb = path.join(chromeRoot, 'Profile 1', 'Local Storage', 'leveldb');
        fs.mkdirSync(defaultLevelDb, { recursive: true });
        fs.mkdirSync(profileLevelDb, { recursive: true });
        try {
            writeLevelDbLog(defaultLevelDb, { access_token: makeJwt(Date.now() / 1000 - 3600) });
            writeLevelDbLog(profileLevelDb, { refresh_token: 'valid-refresh-token' });

            expect(resolveKimiWebAuthSession({}, homeDir)).toEqual({ refreshToken: 'valid-refresh-token' });
        } finally {
            fs.rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it('treats KIMI_AUTH_TOKEN as an explicit access token', () => {
        const token = makeJwt(Date.now() / 1000 + 3600);
        expect(resolveKimiWebAuthSession({ KIMI_AUTH_TOKEN: token })).toEqual({ accessToken: token });
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
