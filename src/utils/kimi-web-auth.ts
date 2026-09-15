import { execFileSync } from 'child_process';
import {
    createDecipheriv,
    createHash,
    pbkdf2Sync
} from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Resolves the kimi.com web session used by the membership APIs. Current web
// sessions live in Chromium Local Storage; the old kimi-auth cookie is retained
// only as a fallback for browser profiles that still have one.

const CHROMIUM_KEYCHAIN_ITERATIONS = 1003;
const CHROMIUM_KEYCHAIN_SALT = 'saltysalt';
const CHROMIUM_COOKIE_IV = Buffer.alloc(16, 0x20);
const LEVELDB_BLOCK_SIZE = 32768;
const LEVELDB_FOOTER_SIZE = 48;
const LEVELDB_MAGIC = 0xdb4775248b80fb57n;
const KIMI_STORAGE_ORIGIN = 'https://www.kimi.com';
const SQLITE3_BINARY = '/usr/bin/sqlite3';
const SECURITY_BINARY = '/usr/bin/security';

export interface KimiWebAuthSession {
    accessToken?: string;
    refreshToken?: string;
}

interface ChromiumBrowserProfile {
    keychainAccount: string;
    keychainService: string;
    cookiesDbPath: string;
    localStorageDbPath: string;
}

interface LevelDbRecord {
    key: Buffer;
    sequence: bigint;
    state: number;
    value: Buffer;
}

interface BlockHandle {
    length: number;
    offset: number;
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

        entries.sort((left, right) => {
            if (left.name === 'Default')
                return -1;
            if (right.name === 'Default')
                return 1;
            return left.name.localeCompare(right.name, undefined, { numeric: true });
        });
        for (const entry of entries) {
            if (!entry.isDirectory() || (entry.name !== 'Default' && !/^Profile \d+$/.test(entry.name))) {
                continue;
            }

            const profileRoot = path.join(root, entry.name);
            const cookiesDbPath = path.join(profileRoot, 'Cookies');
            const localStorageDbPath = path.join(profileRoot, 'Local Storage', 'leveldb');
            if (fs.existsSync(cookiesDbPath) || fs.existsSync(localStorageDbPath)) {
                profiles.push({
                    keychainService: browser.service,
                    keychainAccount: browser.account,
                    cookiesDbPath,
                    localStorageDbPath
                });
            }
        }
    }

    return profiles;
}

function readVarint(buffer: Buffer, startOffset: number): { offset: number; value: number } | null {
    let value = 0;
    let multiplier = 1;
    let offset = startOffset;

    for (let index = 0; index < 10 && offset < buffer.length; index += 1) {
        const byte = buffer[offset++];
        if (byte === undefined) {
            return null;
        }
        value += (byte & 0x7f) * multiplier;
        if ((byte & 0x80) === 0) {
            return Number.isSafeInteger(value) ? { value, offset } : null;
        }
        multiplier *= 128;
    }

    return null;
}

function decompressSnappy(input: Buffer): Buffer | null {
    const lengthResult = readVarint(input, 0);
    if (!lengthResult) {
        return null;
    }

    const output = Buffer.allocUnsafe(lengthResult.value);
    let inputOffset = lengthResult.offset;
    let outputOffset = 0;

    try {
        while (inputOffset < input.length) {
            const tag = input[inputOffset++];
            if (tag === undefined) {
                return null;
            }
            const type = tag & 0x03;

            if (type === 0) {
                let length = tag >>> 2;
                if (length < 60) {
                    length += 1;
                } else {
                    const lengthBytes = length - 59;
                    length = 0;
                    for (let index = 0; index < lengthBytes; index += 1) {
                        const byte = input[inputOffset++];
                        if (byte === undefined) {
                            return null;
                        }
                        length += byte * 2 ** (index * 8);
                    }
                    length += 1;
                }
                input.copy(output, outputOffset, inputOffset, inputOffset + length);
                inputOffset += length;
                outputOffset += length;
                continue;
            }

            let copyLength: number;
            let copyOffset: number;
            if (type === 1) {
                const lowOffset = input[inputOffset++];
                if (lowOffset === undefined) {
                    return null;
                }
                copyLength = ((tag >>> 2) & 0x07) + 4;
                copyOffset = ((tag & 0xe0) << 3) | lowOffset;
            } else if (type === 2) {
                copyLength = (tag >>> 2) + 1;
                copyOffset = input.readUInt16LE(inputOffset);
                inputOffset += 2;
            } else {
                copyLength = (tag >>> 2) + 1;
                copyOffset = input.readUInt32LE(inputOffset);
                inputOffset += 4;
            }

            if (copyOffset <= 0 || copyOffset > outputOffset) {
                return null;
            }
            for (let index = 0; index < copyLength; index += 1) {
                const sourceByte = output[outputOffset - copyOffset];
                if (sourceByte === undefined) {
                    return null;
                }
                output[outputOffset] = sourceByte;
                outputOffset += 1;
            }
        }
    } catch {
        return null;
    }

    return outputOffset === output.length ? output : null;
}

function readBlockEntries(block: Buffer): { key: Buffer; value: Buffer }[] {
    if (block.length < 4) {
        return [];
    }

    const restartCount = block.readUInt32LE(block.length - 4);
    const restartOffset = block.length - (restartCount + 1) * 4;
    if (restartOffset < 0 || restartOffset > block.length - 4) {
        return [];
    }

    const entries: { key: Buffer; value: Buffer }[] = [];
    let offset = restartCount > 0 ? block.readUInt32LE(restartOffset) : 0;
    let previousKey = Buffer.alloc(0);

    while (offset < restartOffset) {
        const shared = readVarint(block, offset);
        const nonShared = shared ? readVarint(block, shared.offset) : null;
        const valueLength = nonShared ? readVarint(block, nonShared.offset) : null;
        if (!shared || !nonShared || !valueLength || shared.value > previousKey.length) {
            break;
        }

        const keyEnd = valueLength.offset + nonShared.value;
        const valueEnd = keyEnd + valueLength.value;
        if (valueEnd > restartOffset) {
            break;
        }

        const key = Buffer.concat([
            previousKey.subarray(0, shared.value),
            block.subarray(valueLength.offset, keyEnd)
        ]);
        entries.push({ key, value: block.subarray(keyEnd, valueEnd) });
        previousKey = key;
        offset = valueEnd;
    }

    return entries;
}

function readBlockHandle(buffer: Buffer, startOffset: number): { handle: BlockHandle; offset: number } | null {
    const blockOffset = readVarint(buffer, startOffset);
    const blockLength = blockOffset ? readVarint(buffer, blockOffset.offset) : null;
    return blockOffset && blockLength
        ? { handle: { offset: blockOffset.value, length: blockLength.value }, offset: blockLength.offset }
        : null;
}

function readTableBlock(file: Buffer, handle: BlockHandle): Buffer | null {
    const trailerOffset = handle.offset + handle.length;
    if (handle.offset < 0 || trailerOffset + 5 > file.length) {
        return null;
    }

    const raw = file.subarray(handle.offset, trailerOffset);
    const compressionType = file[trailerOffset];
    if (compressionType === 0) {
        return raw;
    }
    return compressionType === 1 ? decompressSnappy(raw) : null;
}

function readTableRecords(file: Buffer): LevelDbRecord[] {
    if (file.length < LEVELDB_FOOTER_SIZE || file.readBigUInt64LE(file.length - 8) !== LEVELDB_MAGIC) {
        return [];
    }

    const footer = file.subarray(file.length - LEVELDB_FOOTER_SIZE, file.length - 8);
    const metaHandle = readBlockHandle(footer, 0);
    const indexHandle = metaHandle ? readBlockHandle(footer, metaHandle.offset) : null;
    if (!indexHandle) {
        return [];
    }

    const indexBlock = readTableBlock(file, indexHandle.handle);
    if (!indexBlock) {
        return [];
    }

    const records: LevelDbRecord[] = [];
    for (const indexEntry of readBlockEntries(indexBlock)) {
        const dataHandle = readBlockHandle(indexEntry.value, 0);
        const dataBlock = dataHandle ? readTableBlock(file, dataHandle.handle) : null;
        if (!dataBlock) {
            continue;
        }

        for (const entry of readBlockEntries(dataBlock)) {
            if (entry.key.length < 8) {
                continue;
            }
            const metadata = entry.key.readBigUInt64LE(entry.key.length - 8);
            records.push({
                key: entry.key.subarray(0, -8),
                sequence: metadata >> 8n,
                state: Number(metadata & 0xffn),
                value: entry.value
            });
        }
    }

    return records;
}

function readLogRecords(file: Buffer): LevelDbRecord[] {
    const batches: Buffer[] = [];
    let partial: Buffer[] | null = null;

    for (let blockOffset = 0; blockOffset < file.length; blockOffset += LEVELDB_BLOCK_SIZE) {
        const blockEnd = Math.min(blockOffset + LEVELDB_BLOCK_SIZE, file.length);
        let offset = blockOffset;
        while (offset + 7 <= blockEnd) {
            const length = file.readUInt16LE(offset + 4);
            const type = file[offset + 6];
            offset += 7;
            if (!type || offset + length > blockEnd) {
                break;
            }
            const fragment = file.subarray(offset, offset + length);
            offset += length;

            if (type === 1) {
                batches.push(fragment);
                partial = null;
            } else if (type === 2) {
                partial = [fragment];
            } else if (type === 3 && partial) {
                partial.push(fragment);
            } else if (type === 4 && partial) {
                partial.push(fragment);
                batches.push(Buffer.concat(partial));
                partial = null;
            }
        }
    }

    const records: LevelDbRecord[] = [];
    for (const batch of batches) {
        if (batch.length < 12) {
            continue;
        }
        const firstSequence = batch.readBigUInt64LE(0);
        const count = batch.readUInt32LE(8);
        let offset = 12;

        for (let index = 0; index < count && offset < batch.length; index += 1) {
            const state = batch[offset++];
            const keyLength = readVarint(batch, offset);
            if (state === undefined || !keyLength) {
                break;
            }
            offset = keyLength.offset;
            const keyEnd = offset + keyLength.value;
            if (keyEnd > batch.length) {
                break;
            }
            const key = batch.subarray(offset, keyEnd);
            offset = keyEnd;

            let value = Buffer.alloc(0);
            if (state !== 0) {
                const valueLength = readVarint(batch, offset);
                if (!valueLength) {
                    break;
                }
                offset = valueLength.offset;
                const valueEnd = offset + valueLength.value;
                if (valueEnd > batch.length) {
                    break;
                }
                value = Buffer.from(batch.subarray(offset, valueEnd));
                offset = valueEnd;
            }

            records.push({ key, sequence: firstSequence + BigInt(index), state, value });
        }
    }

    return records;
}

function decodeChromiumString(value: Buffer): string | null {
    const encoding = value[0];
    try {
        if (encoding === 0) {
            return value.subarray(1).toString('utf16le');
        }
        if (encoding === 1) {
            return value.subarray(1).toString('latin1');
        }
    } catch {
        return null;
    }
    return null;
}

export function readKimiWebAuthSessionFromLevelDb(levelDbPath: string): KimiWebAuthSession | null {
    const wantedKeys = new Map<string, { sequence: bigint; value?: string }>();
    let fileNames: string[];
    try {
        fileNames = fs.readdirSync(levelDbPath)
            .filter(name => /^\d+\.(?:ldb|log|sst)$/.test(name))
            .sort((left, right) => Number.parseInt(right, 10) - Number.parseInt(left, 10));
    } catch {
        return null;
    }

    const keyPrefix = Buffer.from(`_${KIMI_STORAGE_ORIGIN}\0`, 'latin1');
    for (const fileName of fileNames) {
        let file: Buffer;
        try {
            file = fs.readFileSync(path.join(levelDbPath, fileName));
        } catch {
            continue;
        }

        const records = fileName.endsWith('.log') ? readLogRecords(file) : readTableRecords(file);
        for (const record of records) {
            if (!record.key.subarray(0, keyPrefix.length).equals(keyPrefix)) {
                continue;
            }
            const scriptKey = decodeChromiumString(record.key.subarray(keyPrefix.length));
            if (scriptKey !== 'access_token' && scriptKey !== 'refresh_token') {
                continue;
            }

            const previous = wantedKeys.get(scriptKey);
            if (!previous || record.sequence > previous.sequence) {
                wantedKeys.set(scriptKey, {
                    sequence: record.sequence,
                    value: record.state === 1 ? decodeChromiumString(record.value) ?? undefined : undefined
                });
            }
        }
    }

    const accessToken = nonEmpty(wantedKeys.get('access_token')?.value);
    const refreshToken = nonEmpty(wantedKeys.get('refresh_token')?.value);
    return accessToken || refreshToken ? { accessToken, refreshToken } : null;
}

function readKimiWebAuthSessionFromLocalStorage(localStorageDbPath: string): KimiWebAuthSession | null {
    let tempDir: string | null = null;
    try {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-kimi-localstorage-'));
        for (const fileName of fs.readdirSync(localStorageDbPath)) {
            if (!/^\d+\.(?:ldb|log|sst)$/.test(fileName)) {
                continue;
            }
            try {
                fs.copyFileSync(path.join(localStorageDbPath, fileName), path.join(tempDir, fileName));
            } catch {
                // Chrome may compact and remove a file between listing and copying.
            }
        }
        return readKimiWebAuthSessionFromLevelDb(tempDir);
    } catch {
        return null;
    } finally {
        if (tempDir) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {
                // Temporary cleanup is best-effort.
            }
        }
    }
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

function readKimiAuthTokenFromCookie(profile: ChromiumBrowserProfile): string | null {
    const cookie = readEncryptedKimiAuthCookie(profile.cookiesDbPath);
    if (!cookie) {
        return null;
    }

    const key = readSafeStorageKey(profile.keychainService, profile.keychainAccount);
    if (!key) {
        return null;
    }

    const token = decryptChromiumCookieValue(cookie.value, key, cookie.hostKey);
    return token && isKimiJwtUsable(token) ? token : null;
}

function readKimiWebAuthSessionFromBrowsers(homeDir = os.homedir()): KimiWebAuthSession | null {
    if (process.platform !== 'darwin') {
        return null;
    }

    const profiles = listChromiumProfiles(homeDir);
    for (const profile of profiles) {
        const session = readKimiWebAuthSessionFromLocalStorage(profile.localStorageDbPath);
        if (session?.refreshToken || (session?.accessToken && isKimiJwtUsable(session.accessToken))) {
            return session;
        }
    }

    for (const profile of profiles) {
        const accessToken = readKimiAuthTokenFromCookie(profile);
        if (accessToken) {
            return { accessToken };
        }
    }

    return null;
}

export function resolveKimiWebAuthSession(
    environment: Record<string, string | undefined> = process.env,
    homeDir = os.homedir()
): KimiWebAuthSession | null {
    const explicitToken = nonEmpty(environment.KIMI_AUTH_TOKEN);
    if (explicitToken) {
        return isKimiJwtUsable(explicitToken) ? { accessToken: explicitToken } : null;
    }

    return readKimiWebAuthSessionFromBrowsers(homeDir);
}

export function resolveKimiWebAuthToken(environment: Record<string, string | undefined> = process.env): string | null {
    const accessToken = resolveKimiWebAuthSession(environment)?.accessToken;
    return accessToken && isKimiJwtUsable(accessToken) ? accessToken : null;
}
