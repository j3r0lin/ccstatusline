import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    afterEach,
    beforeEach,
    expect,
    it
} from 'vitest';

let home: string;

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-prices-conc-'));
});

afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
});

function runWorker(log: string): Promise<string> {
    const worker = path.join(import.meta.dir, 'fixtures', 'model-prices-worker.ts');
    return new Promise((resolve, reject) => {
        const env = { ...process.env, PRICES_TEST_HOME: home, PRICES_TEST_LOG: log };
        const child = spawn(process.execPath, [worker], { env });
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', () => {
            resolve(out.trim());
        });
    });
}

it('downloads once across simultaneous renders and never serves a partial file', async () => {
    const log = path.join(home, 'events.log');
    fs.writeFileSync(log, '');

    const outputs = await Promise.all(Array.from({ length: 12 }, () => runWorker(log)));

    const events = fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean);
    expect(events.filter(e => e === 'download')).toHaveLength(1);
    expect(events.filter(e => e === 'spawn')).toHaveLength(1);
    for (const output of outputs) {
        expect(output).toBe('bad=0 glm=7');
    }
}, 60_000);
