import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

// Transcript analysis writes an incremental cache under the home directory;
// point it at a throwaway one so tests never touch the real ~/.cache.
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-test-home-'));
process.env.HOME = isolatedHome;

afterAll(() => {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
});
