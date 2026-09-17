import { execFileSync } from 'child_process';

// The issue-key shape jira-cli / Jira itself uses: an uppercase project key
// (letters and digits, starting with a letter) followed by `-<number>`.
// Branch names carry the key anywhere in the string (e.g.
// `fix/NP-1603-bulk-http-method-case`), so this stays unanchored.
const BRANCH_ISSUE_KEY_PATTERN = /[A-Z][A-Z0-9]+-\d+/;
// MR/PR titles for a linked issue put the key at the very start
// (`IM-3242 [B] ...`); everything else - Conventional Commits titles like
// `fix(apidoc): ...`, or a key mentioned mid-sentence/in parentheses like
// `revert: drop workaround (IM-3015)` - is deliberately not matched. Missing
// that placement is cheaper than misreading `fix: handle UTF-8 in export` as
// project UTF issue 8.
const TITLE_ISSUE_KEY_PATTERN = /^([A-Z][A-Z0-9]+-\d+)\b/;

const CLI_TIMEOUT = 5_000;

export type JiraIssueKeySource = 'branch-config' | 'branch-name' | 'pr-title' | 'transcript';

export interface ResolvedJiraIssueKey {
    key: string;
    source: JiraIssueKeySource;
}

export interface JiraIssueKeyDeps { execFileSync: typeof execFileSync }

const DEFAULT_JIRA_ISSUE_KEY_DEPS: JiraIssueKeyDeps = { execFileSync };

function runGitForKey(args: string[], cwd: string, deps: JiraIssueKeyDeps): string | null {
    try {
        const output = deps.execFileSync('git', args, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
            cwd,
            timeout: CLI_TIMEOUT,
            windowsHide: true
        }).trim();
        return output.length > 0 ? output : null;
    } catch {
        return null;
    }
}

export function getCurrentBranchName(cwd: string, deps: JiraIssueKeyDeps = DEFAULT_JIRA_ISSUE_KEY_DEPS): string | null {
    return runGitForKey(['symbolic-ref', '--short', 'HEAD'], cwd, deps);
}

function getBranchIssueKeyConfig(cwd: string, branch: string, deps: JiraIssueKeyDeps): string | null {
    return runGitForKey(['config', `branch.${branch}.jiraIssue`], cwd, deps);
}

export function extractIssueKeyFromBranchName(branch: string): string | null {
    return BRANCH_ISSUE_KEY_PATTERN.exec(branch)?.[0] ?? null;
}

export function extractIssueKeyFromTitle(title: string): string | null {
    return TITLE_ISSUE_KEY_PATTERN.exec(title)?.[1] ?? null;
}

export interface ResolveJiraIssueKeyParams {
    // null when the render cwd is not a git work tree, which skips the two
    // git-derived sources and leaves the transcript source to answer on its own.
    cwd: string | null;
    // The cached PR/MR title, if any, for the pr-title fallback source.
    prTitle: string | null;
    // A key extracted from a jira-naming command the session actually ran
    // (see jira-transcript-key.ts), for the transcript fallback source.
    transcriptIssueKey: string | null;
}

// Resolution chain, first match wins:
//   1. git config branch.<branch>.jiraIssue - an explicit user override, used
//      as-is.
//   2. the current branch name, matched anywhere in the string.
//   3. the cached PR/MR title, matched only at its start.
//   4. a jira-naming command run earlier in this session's transcript - "I
//      just looked at this issue", less authoritative than "I'm working on
//      this issue" (sources 1-2), so it comes last.
export function resolveJiraIssueKey(
    params: ResolveJiraIssueKeyParams,
    deps: JiraIssueKeyDeps = DEFAULT_JIRA_ISSUE_KEY_DEPS
): ResolvedJiraIssueKey | null {
    const cwd = params.cwd;
    const branch = cwd === null ? null : getCurrentBranchName(cwd, deps);

    if (branch && cwd !== null) {
        const configured = getBranchIssueKeyConfig(cwd, branch, deps);
        if (configured) {
            return { key: configured.toUpperCase(), source: 'branch-config' };
        }

        const fromBranch = extractIssueKeyFromBranchName(branch);
        if (fromBranch) {
            return { key: fromBranch, source: 'branch-name' };
        }
    }

    if (params.prTitle) {
        const fromTitle = extractIssueKeyFromTitle(params.prTitle);
        if (fromTitle) {
            return { key: fromTitle, source: 'pr-title' };
        }
    }

    if (params.transcriptIssueKey) {
        return { key: params.transcriptIssueKey, source: 'transcript' };
    }

    return null;
}
