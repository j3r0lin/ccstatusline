import type { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

import { readCurrentBranch } from '../git-head';
import { getCurrentBranchName } from '../jira-issue-key';

const directories: string[] = [];
// Bun.spawnSync, not node:child_process: other test files vi.mock that module and the mock leaks across files.
function run(file: string, args: string[], cwd: string): string {
    const result = Bun.spawnSync([file, ...args], { cwd, stdout: 'pipe', stderr: 'ignore' });
    if (result.exitCode !== 0)
        throw new Error(`${file} ${args.join(' ')} exited ${result.exitCode}`);
    return result.stdout.toString();
}
function git(cwd: string, ...args: string[]): string {
    return run('git', args, cwd).trim();
}
const realGit = { execFileSync: ((file: string, args: string[], options: { cwd: string }) => run(file, args, options.cwd)) as unknown as typeof execFileSync };
function repository(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-head-test-'));
    directories.push(dir);
    git(dir, 'init', '-b', 'feature/example');
    git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'initial');
    return dir;
}
afterEach(() => {
    for (const dir of directories.splice(0))
        fs.rmSync(dir, { recursive: true, force: true });
});

describe('current git branch', () => {
    it('matches git in ordinary repositories and worktrees', () => {
        const dir = repository();
        const worktree = path.join(dir, 'other');
        git(dir, 'worktree', 'add', '-b', 'other-branch', worktree);
        for (const cwd of [dir, worktree]) {
            expect(readCurrentBranch(cwd)).toBe(git(cwd, 'symbolic-ref', '--short', 'HEAD'));
            expect(getCurrentBranchName(cwd, realGit)).toBe(git(cwd, 'symbolic-ref', '--short', 'HEAD'));
        }
    });
    it('finds the physical repository when cwd is a symlink', () => {
        const first = repository();
        const second = repository();
        git(second, 'switch', '-c', 'other-branch');
        const subdir = path.join(second, 'nested');
        fs.mkdirSync(subdir);
        const link = path.join(first, 'link');
        fs.symlinkSync(subdir, link);
        expect(getCurrentBranchName(link, realGit)).toBe(git(link, 'symbolic-ref', '--short', 'HEAD'));
    });
    it('falls back for detached HEAD', () => {
        const dir = repository();
        git(dir, 'checkout', '--detach');
        expect(readCurrentBranch(dir)).toBeNull();
        expect(getCurrentBranchName(dir, realGit)).toBeNull();
    });
    it('falls back when a tag makes the short name ambiguous', () => {
        const dir = repository();
        git(dir, 'update-ref', 'refs/tags/feature/example', 'HEAD');
        expect(readCurrentBranch(dir)).toBeNull();
        expect(getCurrentBranchName(dir, realGit)).toBe(git(dir, 'symbolic-ref', '--short', 'HEAD'));
    });
});
