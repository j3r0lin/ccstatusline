import {
    describe,
    expect,
    it
} from 'vitest';

import {
    extractIssueKeyFromBranchName,
    extractIssueKeyFromTitle,
    getCurrentBranchName,
    resolveJiraIssueKey,
    type JiraIssueKeyDeps
} from '../jira-issue-key';

function createDeps(overrides: {
    branch?: string | null;
    branchConfig?: string | null;
} = {}): JiraIssueKeyDeps {
    const branch = overrides.branch === undefined ? 'feature/im-3299-fix' : overrides.branch;
    const branchConfig = overrides.branchConfig ?? null;

    return {
        execFileSync: ((cmd: string, args: readonly string[]) => {
            if (cmd !== 'git') {
                throw new Error(`unexpected command: ${cmd}`);
            }
            if (args[0] === 'symbolic-ref') {
                if (branch === null) {
                    throw new Error('not on a branch');
                }
                return `${branch}\n`;
            }
            if (args[0] === 'config') {
                if (branchConfig === null) {
                    throw new Error('no such config key');
                }
                return `${branchConfig}\n`;
            }
            throw new Error(`unexpected git args: ${args.join(' ')}`);
        }) as JiraIssueKeyDeps['execFileSync']
    };
}

describe('extractIssueKeyFromBranchName', () => {
    it('matches a key found anywhere in the branch name', () => {
        expect(extractIssueKeyFromBranchName('fix/NP-1603-bulk-http-method-case')).toBe('NP-1603');
        expect(extractIssueKeyFromBranchName('IM-3299-fix-widget')).toBe('IM-3299');
    });

    it('returns null when the branch name has no key-shaped substring', () => {
        expect(extractIssueKeyFromBranchName('fix/utf-8-encoding')).toBeNull();
    });
});

describe('extractIssueKeyFromTitle', () => {
    it('matches a key at the very start of the title', () => {
        expect(extractIssueKeyFromTitle('IM-3242 [B] Activity Log 设备维度地基')).toBe('IM-3242');
        expect(extractIssueKeyFromTitle('NP-1603 OMS平台批量删除许可证报错 500 ClassCastException')).toBe('NP-1603');
    });

    it('does not match a Conventional Commits title with no leading key', () => {
        expect(extractIssueKeyFromTitle('fix(apidoc): migrate ApiDocService to AWS SDK v2')).toBeNull();
        expect(extractIssueKeyFromTitle('chore: upgrade to nezha-commons 2.0.0 (Spring Boot 4 / JDK 25)')).toBeNull();
    });

    it('does not match a UTF-8-shaped lookalike mid-sentence', () => {
        expect(extractIssueKeyFromTitle('fix: handle UTF-8 in export')).toBeNull();
    });

    // Deliberate trade-off: a key that names the issue but isn't at the start
    // (mid-sentence, or parenthesized like a Conventional Commits footer) is
    // missed. Requiring the start position is what lets this source skip a
    // project-key whitelist entirely; missing this placement is cheaper than
    // misreading `fix: handle UTF-8 in export` as project UTF issue 8.
    it('does not match a key placed later in the title, e.g. a parenthesized reference', () => {
        expect(extractIssueKeyFromTitle('revert: drop workaround nats runtime dependency (IM-3015)')).toBeNull();
    });
});

describe('getCurrentBranchName', () => {
    it('returns null when not on a branch', () => {
        expect(getCurrentBranchName('/tmp/repo', createDeps({ branch: null }))).toBeNull();
    });
});

describe('resolveJiraIssueKey', () => {
    it('prefers the branch.<branch>.jiraIssue git config over the branch name', () => {
        const deps = createDeps({ branch: 'feature/im-9999-other', branchConfig: 'im-3299' });
        expect(resolveJiraIssueKey({ cwd: '/tmp/repo', prTitle: null, transcriptIssueKey: null }, deps)).toEqual({
            key: 'IM-3299',
            source: 'branch-config'
        });
    });

    it('falls back to the branch name when no git config is set', () => {
        const deps = createDeps({ branch: 'feature/IM-3299-fix', branchConfig: null });
        expect(resolveJiraIssueKey({ cwd: '/tmp/repo', prTitle: null, transcriptIssueKey: null }, deps)).toEqual({
            key: 'IM-3299',
            source: 'branch-name'
        });
    });

    it('falls back to the cached PR/MR title when the branch name has no match', () => {
        const deps = createDeps({ branch: 'feature/cleanup', branchConfig: null });
        expect(resolveJiraIssueKey({
            cwd: '/tmp/repo',
            prTitle: 'NP-1603 OMS平台批量删除许可证报错 500 ClassCastException',
            transcriptIssueKey: null
        }, deps)).toEqual({
            key: 'NP-1603',
            source: 'pr-title'
        });
    });

    it('does not match a Conventional Commits title with no linked issue', () => {
        const deps = createDeps({ branch: 'feature/cleanup', branchConfig: null });
        expect(resolveJiraIssueKey({
            cwd: '/tmp/repo',
            prTitle: 'fix: handle UTF-8 in export',
            transcriptIssueKey: null
        }, deps)).toBeNull();
    });

    it('falls back to the transcript-resolved key when nothing else matches', () => {
        const deps = createDeps({ branch: 'feature/cleanup', branchConfig: null });
        expect(resolveJiraIssueKey({
            cwd: '/tmp/repo',
            prTitle: 'unrelated title',
            transcriptIssueKey: 'NP-1637'
        }, deps)).toEqual({
            key: 'NP-1637',
            source: 'transcript'
        });
    });

    it('prefers the branch name over the transcript-resolved key', () => {
        const deps = createDeps({ branch: 'feature/IM-3299-fix', branchConfig: null });
        expect(resolveJiraIssueKey({
            cwd: '/tmp/repo',
            prTitle: null,
            transcriptIssueKey: 'NP-1637'
        }, deps)).toEqual({
            key: 'IM-3299',
            source: 'branch-name'
        });
    });

    it('prefers the PR/MR title over the transcript-resolved key', () => {
        const deps = createDeps({ branch: 'feature/cleanup', branchConfig: null });
        expect(resolveJiraIssueKey({
            cwd: '/tmp/repo',
            prTitle: 'IM-3242 [B] Activity Log',
            transcriptIssueKey: 'NP-1637'
        }, deps)).toEqual({
            key: 'IM-3242',
            source: 'pr-title'
        });
    });

    it('returns null when no source resolves a key', () => {
        const deps = createDeps({ branch: 'feature/cleanup', branchConfig: null });
        expect(resolveJiraIssueKey({
            cwd: '/tmp/repo',
            prTitle: 'unrelated title',
            transcriptIssueKey: null
        }, deps)).toBeNull();
    });
});
