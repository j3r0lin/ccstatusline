import { execFileSync } from 'child_process';
import {
    createDecipheriv,
    createHash,
    pbkdf2Sync
} from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Resolves the kimi-auth web session JWT used by the kimi.com membership APIs.
// The coding API key cannot call these endpoints (it is not a JWT), so the
// token comes from an explicit KIMI_AUTH_TOKEN env var or from the cookie store
// of a Chromium-family browser where the user is logged in to kimi.com.

const CHROMIUM_KEYCHAIN_ITERATIONS = 1003;
const CHROMIUM_KEYCHAIN_SALT = 'saltysalt';
const CHROMIUM_COOKIE_IV = Buffer.alloc(16, 0x20);
const SQLITE3_BINARY = '/usr/bin/sqlite3';
const SECURITY_BINARY = '/usr/bin/security';

interface ChromiumBrowserProfile {
    keychainAccount: string;
    keychainService: string;
    cookiesDbPath: string;
}

const CHROMIUM_BROWSER_ROOTS: { account: string; relativePath: string; service: string }[] = [
    { service: 'Chrome Safe Storage', account: 'Chrome', relativePath: path.join('Google', 'Chrome') },
    { service: 'Arc Safe Storage', account: 'Arc', relativePath: path.join('Arc', 'User Data') },
    { service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge', relativePath: 'Microsoft Edge' },
    { service: 'Brave Safe Storage', account: 'Brave', relativePath: path.join('BraveSoftware', 'Brave-Browser') },
    { service: 'Chromium Safe Storage', account: 'Chromium', relativePath: 'Chromium' }
];

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed?.length ? trimmed : undefined;
}

export function decodeKimiJwtPayload(jwt: string): Record<string, unknown> | null {
    const parts = jwt.split('.');
    const payloadPart = parts[1];
    if (parts.length !== 3 || !payloadPart) {
        return null;
    }

    try {
        const payload = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
        const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
        return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

export function isKimiJwtUsable(jwt: string, nowMs = Date.now()): boolean {
    const claims = decodeKimiJwtPayload(jwt);
    const expSeconds = claims?.exp;
    if (typeof expSeconds !== 'number') {
        return false;
    }

    // Treat tokens inside a 60s expiry grace as already expired so a statusline
    // render never hands an about-to-die token to the API.
    return expSeconds * 1000 > nowMs + 60_000;
}

// Chromium macOS cookies: AES-128-CBC, key = PBKDF2-HMAC-SHA1(safe storage
// password, "saltysalt", 1003, 16 bytes), IV = 16 spaces, "v10" prefix.
// Cookie DB version 24+ prefixes the plaintext with SHA-256(host_key).
export function decryptChromiumCookieValue(encryptedValue: Buffer, key: Buffer, hostKey: string): string | null {
    if (encryptedValue.length <= 3 || encryptedValue.subarray(0, 3).toString('utf8') !== 'v10') {
        return null;
    }

    try {
        const decipher = createDecipheriv('aes-128-cbc', key, CHROMIUM_COOKIE_IV);
        const plaintext = Buffer.concat([decipher.update(encryptedValue.subarray(3)), decipher.final()]);
        const domainHash = createHash('sha256').update(hostKey).digest();
        if (plaintext.subarray(0, domainHash.length).equals(domainHash)) {
            return plaintext.subarray(domainHash.length).toString('utf8');
        }
        return plaintext.toString('utf8');
    } catch {
        return null;
    }
}

function listChromiumProfiles(homeDir: string): ChromiumBrowserProfile[] {
    const profiles: ChromiumBrowserProfile[] = [];

    for (const browser of CHROMIUM_BROWSER_ROOTS) {
        const root = path.join(homeDir, 'Library', 'Application Support', browser.relativePath);
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory() || (entry.name !== 'Default' && !/^Profile \d+$/.test(entry.name))) {
                continue;
            }

            const cookiesDbPath = path.join(root, entry.name, 'Cookies');
            if (fs.existsSync(cookiesDbPath)) {
                profiles.push({
                    keychainService: browser.service,
                    keychainAccount: browser.account,
                    cookiesDbPath
                });
            }
        }
    }

    return profiles;
}

function readEncryptedKimiAuthCookie(cookiesDbPath: string): { hostKey: string; value: Buffer } | null {
    try {
        const output = execFileSync(SQLITE3_BINARY, [
            '-readonly',
            '-separator', '|',
            `file:${cookiesDbPath}?immutable=1`,
            'SELECT host_key, hex(encrypted_value) FROM cookies'
            + ' WHERE name = \'kimi-auth\' AND host_key LIKE \'%kimi.com\''
            + ' ORDER BY expires_utc DESC LIMIT 1;'
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }).trim();

        const separatorIndex = output.indexOf('|');
        if (separatorIndex <= 0) {
            return null;
        }

        return {
            hostKey: output.slice(0, separatorIndex),
            value: Buffer.from(output.slice(separatorIndex + 1), 'hex')
        };
    } catch {
        return null;
    }
}

function readSafeStorageKey(service: string, account: string): Buffer | null {
    try {
        const password = execFileSync(SECURITY_BINARY, [
            'find-generic-password', '-w', '-s', service, '-a', account
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }).trim();
        if (!password) {
            return null;
        }
        return pbkdf2Sync(password, CHROMIUM_KEYCHAIN_SALT, CHROMIUM_KEYCHAIN_ITERATIONS, 16, 'sha1');
    } catch {
        return null;
    }
}

function readKimiAuthTokenFromBrowsers(homeDir = os.homedir()): string | null {
    if (process.platform !== 'darwin') {
        return null;
    }

    for (const profile of listChromiumProfiles(homeDir)) {
        const cookie = readEncryptedKimiAuthCookie(profile.cookiesDbPath);
        if (!cookie) {
            continue;
        }

        const key = readSafeStorageKey(profile.keychainService, profile.keychainAccount);
        if (!key) {
            continue;
        }

        const token = decryptChromiumCookieValue(cookie.value, key, cookie.hostKey);
        if (token && isKimiJwtUsable(token)) {
            return token;
        }
    }

    return null;
}

export function resolveKimiWebAuthToken(environment: Record<string, string | undefined> = process.env): string | null {
    const explicitToken = nonEmpty(environment.KIMI_AUTH_TOKEN);
    if (explicitToken) {
        return isKimiJwtUsable(explicitToken) ? explicitToken : null;
    }

    return readKimiAuthTokenFromBrowsers();
}
