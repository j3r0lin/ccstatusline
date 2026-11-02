import type * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it
} from 'vitest';

import type {
    CustomCommandRequest,
    CustomCommandResult
} from '../custom-command';

// Run outside the test process: other suites mock child_process globally under
// Bun, which would replace the spawn these tests exist to exercise.
const require = createRequire(import.meta.url);
const { execFileSync } = require('node:child_process') as typeof childProcess;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-prefetch-'));
const bundlePath = path.join(tempRoot, 'custom-command.mjs');
const probePath = path.join(tempRoot, 'probe.mjs');
const writerPath = path.join(tempRoot, 'writer.cjs');

beforeAll(() => {
    execFileSync('bun', [
        'build',
        fileURLToPath(new URL('../custom-command.ts', import.meta.url)),
        '--target=bun',
        `--outfile=${bundlePath}`
    ], { stdio: 'pipe' });
    // Prefetches the requests, then runs each call, so a test sees what a
    // render pass sees. Under Bun, like the shipped status line.
    fs.writeFileSync(probePath, `
        import { prefetchCustomCommands, runCustomCommand } from './custom-command.mjs';
        const { prefetch, calls } = JSON.parse(process.argv[2]);
        const start = Date.now();
        await prefetchCustomCommands(prefetch);
        const results = calls.map(request => runCustomCommand(request));
        console.log(JSON.stringify({ results, elapsed: Date.now() - start }));
    `);
    fs.writeFileSync(writerPath, `
        const fs = require('node:fs');
        const { spawn } = require('node:child_process');
        const mode = process.argv[2];
        if (mode === 'count') {
            fs.appendFileSync(process.argv[3], 'run\\n');
            process.stdout.write('OUT');
        } else if (mode === 'overflow') {
            process.stdout.write(Buffer.alloc(4 * 1024 * 1024, 'x'));
            setInterval(() => process.stdout.write(Buffer.alloc(1024 * 1024, 'x')), 10);
        } else if (mode === 'timeout-tree') {
            spawn(process.execPath, [__filename, 'sentinel', process.argv[3]], { stdio: ['ignore', 1, 'ignore'] }).unref();
            console.log('EARLY');
            setInterval(() => {}, 1000);
        } else if (mode === 'sentinel') {
            setTimeout(() => {
                fs.writeFileSync(process.argv[3], 'survived');
            }, 1200);
        }
    `);
});

afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function request(command: string, overrides: Partial<CustomCommandRequest> = {}): CustomCommandRequest {
    return {
        command,
        input: '{}',
        timeoutMs: 2000,
        ttlSeconds: 0,
        sessionId: 'prefetch-test',
        ...overrides
    };
}

function prefetchThenRun(prefetch: CustomCommandRequest[], calls: CustomCommandRequest[]) {
    const output = execFileSync('bun', [probePath, JSON.stringify({ prefetch, calls })], {
        encoding: 'utf8',
        timeout: 30_000,
        // The last-success store is written even with TTL 0, so keep it out of
        // the real home directory.
        env: { ...process.env, HOME: tempRoot, USERPROFILE: tempRoot },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    return JSON.parse(output) as { results: CustomCommandResult[]; elapsed: number };
}

function lineCount(filePath: string): number {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).length : 0;
}

describe.skipIf(process.platform === 'win32')('prefetchCustomCommands', () => {
    it('serves the prefetched output without running the command again', () => {
        const counter = path.join(tempRoot, 'count-a');
        const req = request(`"${process.execPath}" "${writerPath}" count "${counter}"`);
        expect(prefetchThenRun([req], [req]).results).toEqual([{ status: 'ok', stdout: 'OUT' }]);
        expect(lineCount(counter)).toBe(1);
    });

    it('uses a prefetched result once', () => {
        const counter = path.join(tempRoot, 'count-e');
        const req = request(`"${process.execPath}" "${writerPath}" count "${counter}"`);
        const { results } = prefetchThenRun([req], [req, req]);
        expect(results).toEqual([{ status: 'ok', stdout: 'OUT' }, { status: 'ok', stdout: 'OUT' }]);
        expect(lineCount(counter)).toBe(2);
    });

    it('rejects output past 1 MiB well before the timeout', () => {
        const req = request(`"${process.execPath}" "${writerPath}" overflow`, { timeoutMs: 20_000 });
        const { results, elapsed } = prefetchThenRun([req], [req]);
        expect(results).toEqual([{ status: 'failed', marker: '[Error]' }]);
        expect(elapsed).toBeLessThan(5000);
    });

    it('falls back to empty on timeout and kills the descendants', async () => {
        const sentinel = path.join(tempRoot, 'timeout-sentinel');
        const req = request(`"${process.execPath}" "${writerPath}" timeout-tree "${sentinel}"`, { timeoutMs: 300 });
        expect(prefetchThenRun([req], [req]).results).toEqual([{ status: 'ok', stdout: '' }]);
        await new Promise(resolve => setTimeout(resolve, 1600));
        expect(fs.existsSync(sentinel)).toBe(false);
    });

    it('returns once the deadline passes even if a background job holds stdout', () => {
        const req = request('echo X; sleep 5 &', { timeoutMs: 1500 });
        const { results, elapsed } = prefetchThenRun([req], [req]);
        expect(results).toEqual([{ status: 'ok', stdout: 'X' }]);
        expect(elapsed).toBeLessThan(3000);
    });

    it('skips commands the cache already answers', () => {
        const counter = path.join(tempRoot, 'count-cached');
        const req = request(`"${process.execPath}" "${writerPath}" count "${counter}"`, { ttlSeconds: 30, sessionId: 'prefetch-cached' });
        prefetchThenRun([], [req]);
        prefetchThenRun([req], [req]);
        expect(lineCount(counter)).toBe(1);
    });
});
