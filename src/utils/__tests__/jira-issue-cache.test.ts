import {
    describe,
    expect,
    it
} from 'vitest';

import {
    applyJiraIssueMoveToCache,
    fetchJiraIssueStatus,
    getCachedJiraIssueStatus,
    refreshJiraIssueCacheFromCli,
    type JiraIssueCacheDeps
} from '../jira-issue-cache';

interface FakeCacheFile {
    content: string;
    mtimeMs: number;
}

interface JiraIssueCacheHarness {
    cacheFiles: Map<string, FakeCacheFile>;
    deps: JiraIssueCacheDeps;
    execCalls: { args: string[]; cmd: string }[];
    jiraResponses: (Error | string)[];
    spawnCalls: { args: string[]; command: string }[];
    advanceNow: (milliseconds: number) => void;
}

function createHarness(): JiraIssueCacheHarness {
    const cacheFiles = new Map<string, FakeCacheFile>();
    const execCalls: { args: string[]; cmd: string }[] = [];
    const jiraResponses: (Error | string)[] = [];
    const spawnCalls: { args: string[]; command: string }[] = [];
    let now = 1_700_000_000_000;

    const deps: JiraIssueCacheDeps = {
        closeSync: () => undefined,
        execFileSync: ((cmd, args) => {
            const commandArgs = Array.isArray(args) ? args.map(arg => String(arg)) : [];
            execCalls.push({ args: commandArgs, cmd });

            if (cmd === 'jira' && commandArgs[0] === 'issue' && commandArgs[1] === 'view') {
                const response = jiraResponses.shift();
                if (response instanceof Error) {
                    throw response;
                }
                return response ?? '';
            }

            throw new Error(`Unexpected command: ${cmd} ${commandArgs.join(' ')}`);
        }) as JiraIssueCacheDeps['execFileSync'],
        existsSync: filePath => cacheFiles.has(String(filePath)),
        getExecPath: () => '/usr/bin/node',
        getHomedir: () => '/tmp/home',
        mkdirSync: () => undefined,
        openSync: (filePath) => {
            const normalizedPath = String(filePath);
            if (cacheFiles.has(normalizedPath)) {
                throw new Error('EEXIST');
            }
            cacheFiles.set(normalizedPath, { content: '', mtimeMs: now });
            return 42;
        },
        now: () => now,
        readFileSync: (filePath => cacheFiles.get(String(filePath))?.content ?? '') as JiraIssueCacheDeps['readFileSync'],
        getScriptPath: () => '/app/ccstatusline.js',
        spawn: ((command, args) => {
            spawnCalls.push({ args: Array.isArray(args) ? args.map(arg => String(arg)) : [], command });
            return { unref: () => undefined };
        }) as JiraIssueCacheDeps['spawn'],
        statSync: (filePath => ({ mtimeMs: cacheFiles.get(String(filePath))?.mtimeMs ?? now })) as JiraIssueCacheDeps['statSync'],
        unlinkSync: (filePath) => {
            if (!cacheFiles.delete(String(filePath))) {
                throw new Error('ENOENT');
            }
        },
        writeFileSync: (filePath, content) => {
            const normalizedContent = typeof content === 'string' ? content : Buffer.isBuffer(content) ? content.toString('utf8') : '';
            cacheFiles.set(String(filePath), { content: normalizedContent, mtimeMs: now });
        }
    };

    return {
        cacheFiles,
        deps,
        execCalls,
        jiraResponses,
        spawnCalls,
        advanceNow: (milliseconds) => {
            now += milliseconds;
        }
    };
}

const SAMPLE_RAW_RESPONSE = JSON.stringify({ fields: { status: { name: 'QA', statusCategory: { key: 'done' } } } });

describe('fetchJiraIssueStatus', () => {
    it('fetches and caches the issue status', () => {
        const harness = createHarness();
        harness.jiraResponses.push(SAMPLE_RAW_RESPONSE);

        expect(fetchJiraIssueStatus('IM-3299', harness.deps)).toEqual({
            key: 'IM-3299',
            statusName: 'QA',
            statusCategoryKey: 'done'
        });

        const jiraCalls = harness.execCalls.filter(call => call.cmd === 'jira');
        expect(jiraCalls).toHaveLength(1);
        expect(jiraCalls[0]?.args).toEqual(['issue', 'view', 'IM-3299', '--raw']);
    });

    it('shards the cache by issue key, not by cwd or branch', () => {
        const harness = createHarness();
        harness.jiraResponses.push(SAMPLE_RAW_RESPONSE);
        fetchJiraIssueStatus('IM-3299', harness.deps);

        const cachePaths = [...harness.cacheFiles.keys()].filter(filePath => !filePath.endsWith('.lock'));
        expect(cachePaths).toHaveLength(1);
        expect(cachePaths[0]).toContain('jira-issue-IM-3299.json');
    });

    it('degrades silently to null when the jira CLI is unavailable', () => {
        const harness = createHarness();
        harness.jiraResponses.push(new Error('spawn jira ENOENT'));

        expect(fetchJiraIssueStatus('IM-3299', harness.deps)).toBeNull();
    });

    it('keeps a stale cached value when a refresh fails', () => {
        const harness = createHarness();
        harness.jiraResponses.push(SAMPLE_RAW_RESPONSE);
        fetchJiraIssueStatus('IM-3299', harness.deps);

        harness.advanceNow(120_000);
        harness.jiraResponses.push(new Error('jira: not logged in'));

        expect(fetchJiraIssueStatus('IM-3299', harness.deps)).toEqual({
            key: 'IM-3299',
            statusName: 'QA',
            statusCategoryKey: 'done'
        });
    });
});

describe('getCachedJiraIssueStatus', () => {
    it('returns null and schedules a background refresh on a cache miss', () => {
        const harness = createHarness();

        expect(getCachedJiraIssueStatus('IM-3299', harness.deps)).toBeNull();
        expect(harness.spawnCalls).toHaveLength(1);
        expect(harness.spawnCalls[0]?.args.slice(1, 3)).toEqual([
            '--internal-refresh-jira-issue-cache',
            'IM-3299'
        ]);
    });

    it('returns the cached value without spawning when fresh', () => {
        const harness = createHarness();
        harness.jiraResponses.push(SAMPLE_RAW_RESPONSE);
        fetchJiraIssueStatus('IM-3299', harness.deps);
        harness.spawnCalls.length = 0;

        expect(getCachedJiraIssueStatus('IM-3299', harness.deps)).toEqual({
            key: 'IM-3299',
            statusName: 'QA',
            statusCategoryKey: 'done'
        });
        expect(harness.spawnCalls).toHaveLength(0);
    });
});

function getCachedJiraIssueStatusFromFiles(harness: JiraIssueCacheHarness): unknown {
    const cachePath = [...harness.cacheFiles.keys()].find(filePath => filePath.endsWith('.json') && !filePath.endsWith('.lock'));
    if (!cachePath) {
        return undefined;
    }
    return (JSON.parse(harness.cacheFiles.get(cachePath)?.content ?? '{}') as { data?: unknown }).data;
}

describe('applyJiraIssueMoveToCache', () => {
    it('writes the moved-to status on a cache miss without spawning a refresh', () => {
        const harness = createHarness();

        expect(applyJiraIssueMoveToCache('IM-3299', 'In Progress', harness.deps)).toEqual({
            key: 'IM-3299',
            statusName: 'In Progress',
            statusCategoryKey: ''
        });
        expect(getCachedJiraIssueStatusFromFiles(harness)).toEqual({
            key: 'IM-3299',
            statusName: 'In Progress',
            statusCategoryKey: ''
        });
        expect(harness.spawnCalls).toHaveLength(0);
        expect(harness.execCalls).toHaveLength(0);
    });

    it('overwrites a differing cached status and clears its category', () => {
        const harness = createHarness();
        harness.jiraResponses.push(SAMPLE_RAW_RESPONSE);
        fetchJiraIssueStatus('IM-3299', harness.deps);

        expect(applyJiraIssueMoveToCache('IM-3299', 'In Progress', harness.deps)).toEqual({
            key: 'IM-3299',
            statusName: 'In Progress',
            statusCategoryKey: ''
        });
    });

    it('keeps the authoritative cached record when it already shows the moved-to status', () => {
        const harness = createHarness();
        harness.jiraResponses.push(SAMPLE_RAW_RESPONSE);
        fetchJiraIssueStatus('IM-3299', harness.deps);

        expect(applyJiraIssueMoveToCache('IM-3299', 'QA', harness.deps)).toEqual({
            key: 'IM-3299',
            statusName: 'QA',
            statusCategoryKey: 'done'
        });
    });
});

describe('refreshJiraIssueCacheFromCli', () => {
    it('fetches the status and releases its own lock', () => {
        const harness = createHarness();
        harness.jiraResponses.push(SAMPLE_RAW_RESPONSE);
        getCachedJiraIssueStatus('IM-3299', harness.deps);
        const lockPath = harness.spawnCalls[0]?.args.at(-1);
        if (!lockPath) {
            throw new Error('expected a lock path');
        }

        refreshJiraIssueCacheFromCli('IM-3299', lockPath, harness.deps);

        expect(harness.cacheFiles.has(lockPath)).toBe(false);
        const cachePath = [...harness.cacheFiles.keys()].find(filePath => filePath.endsWith('jira-issue-IM-3299.json'));
        expect(cachePath).toBeDefined();
    });

    it('does not remove a lock path for a different issue key', () => {
        const harness = createHarness();
        harness.jiraResponses.push(SAMPLE_RAW_RESPONSE);
        harness.cacheFiles.set('/tmp/home/.cache/ccstatusline/jira-issue/jira-issue-OTHER.json.lock', { content: '', mtimeMs: 0 });

        refreshJiraIssueCacheFromCli('IM-3299', '/tmp/home/.cache/ccstatusline/jira-issue/jira-issue-OTHER.json.lock', harness.deps);

        expect(harness.cacheFiles.has('/tmp/home/.cache/ccstatusline/jira-issue/jira-issue-OTHER.json.lock')).toBe(true);
    });
});
