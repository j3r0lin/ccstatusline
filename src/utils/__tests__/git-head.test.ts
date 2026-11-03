import { execFileSync } from 'node:child_process';
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
function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
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
            expect(getCurrentBranchName(cwd)).toBe(git(cwd, 'symbolic-ref', '--short', 'HEAD'));
        }
    });
    it('falls back for detached HEAD', () => {
        const dir = repository();
        git(dir, 'checkout', '--detach');
        expect(readCurrentBranch(dir)).toBeNull();
        expect(getCurrentBranchName(dir)).toBeNull();
    });
    it('falls back when a tag makes the short name ambiguous', () => {
        const dir = repository();
        git(dir, 'update-ref', 'refs/tags/feature/example', 'HEAD');
        expect(readCurrentBranch(dir)).toBeNull();
        expect(getCurrentBranchName(dir)).toBe(git(dir, 'symbolic-ref', '--short', 'HEAD'));
    });
});
