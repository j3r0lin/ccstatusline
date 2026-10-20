import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';

export const MODEL_NAMES_FIXTURE = {
    suffixes: { '-free': ' Free' },
    names: {
        'k3': 'K3',
        'k3-256k': 'K3',
        'kimi-for-coding': 'K2',
        'kimi-for-coding-highspeed': 'K2 Fast'
    },
    words: { 'kimi-k': 'K', 'grok-': 'Grok ', '-build-fast': ' Fast' },
    rules: [
        { match: '^claude-([a-z]+)-(\\d+)(?:-(\\d{1,2}))?$', name: '$1 $2.$3', title: true },
        { match: '^gpt-(\\d+(?:\\.\\d+)?)-([a-z]+)$', name: '$2 $1', title: true },
        { match: '^deepseek-v([\\d.]+)-flash$', name: 'DSF $1' },
        { match: '^deepseek-v([\\d.]+)-pro$', name: 'DSP $1' }
    ]
};

/** Points os.homedir() at a temp dir holding the fixture table; returns a restore function. */
export function useModelNamesFixture(table: object | null = MODEL_NAMES_FIXTURE): () => void {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-names-'));
    if (table) {
        fs.mkdirSync(path.join(home, '.config'));
        fs.writeFileSync(path.join(home, '.config', 'model-names.json'), JSON.stringify(table));
    }
    // bun's os.homedir() ignores later changes to $HOME, so stub it.
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    return () => {
        spy.mockRestore();
        fs.rmSync(home, { recursive: true, force: true });
    };
}
