import * as fs from 'fs';
import os from 'os';
import path from 'path';
import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

import {
    DEFAULT_MAX_SCAN_BYTES,
    DEFAULT_MAX_SCAN_LINES,
    extractIssueKeyFromCommand,
    extractIssueMoveFromCommand,
    resolveJiraIssueKeyFromTranscript,
    type JiraTranscriptKeyDeps
} from '../jira-transcript-key';
import { iterateJsonlLinesReverseSync } from '../jsonl-lines';

function bashRecord(command: string): string {
    return JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
}

interface DepsHarness {
    deps: JiraTranscriptKeyDeps;
    scanCallCounter: { value: number };
}

function createDeps(depOverrides: Partial<JiraTranscriptKeyDeps> = {}): DepsHarness {
    const cache = new Map<string, unknown>();
    const scanCallCounter = { value: 0 };

    const deps: JiraTranscriptKeyDeps = {
        iterateJsonlLinesReverseSync: (filePath) => {
            scanCallCounter.value++;
            return iterateJsonlLinesReverseSync(filePath);
        },
        maxScanBytes: DEFAULT_MAX_SCAN_BYTES,
        maxScanLines: DEFAULT_MAX_SCAN_LINES,
        readAuxCache: (prefix, keyPath) => cache.get(`${prefix}:${keyPath}`) ?? null,
        statSync: fs.statSync,
        writeAuxCache: (prefix, keyPath, value) => {
            cache.set(`${prefix}:${keyPath}`, value);
        },
        ...depOverrides
    };

    return { deps, scanCallCounter };
}

describe('extractIssueKeyFromCommand', () => {
    it('matches jira-cli subcommands that name a specific issue', () => {
        expect(extractIssueKeyFromCommand('jira issue view NP-1637 --comments 50')).toBe('NP-1637');
        expect(extractIssueKeyFromCommand('jira issue edit NA-330 --summary "..."')).toBe('NA-330');
        expect(extractIssueKeyFromCommand('jira issue move SA-423 "In Progress"')).toBe('SA-423');
    });

    it('does not match jira issue list, whose next token is a flag or JQL', () => {
        expect(extractIssueKeyFromCommand('jira issue list --plain -q \'project = NA order by created desc\'')).toBeNull();
    });

    it('matches a jira-api.sh style REST path when the command mentions jira', () => {
        expect(extractIssueKeyFromCommand('./jira-api.sh get issue/NA-330')).toBe('NA-330');
    });

    it('does not match a bare issue/<key>-shaped path with no jira mention', () => {
        expect(extractIssueKeyFromCommand('curl https://example.com/issue/NA-330')).toBeNull();
    });

    it('is not filtered by a project-key whitelist - the command context is proof enough', () => {
        // NP is not a project this repo's jira-cli config defaults to (IM is),
        // but the command names it explicitly.
        expect(extractIssueKeyFromCommand('jira issue view NP-1637')).toBe('NP-1637');
    });

    it('matches when global flags sit between jira and the subcommand', () => {
        expect(extractIssueKeyFromCommand('jira --as jianvis issue move DL-285 "In Progress"')).toBe('DL-285');
        expect(extractIssueKeyFromCommand('jira --as=jianvis issue view DL-285')).toBe('DL-285');
        expect(extractIssueKeyFromCommand('jira --as jianvis -c /tmp/config.yaml issue assign DL-285 j3r0lin')).toBe('DL-285');
    });
});

describe('extractIssueMoveFromCommand', () => {
    it('extracts the key and target status from jira issue move', () => {
        expect(extractIssueMoveFromCommand('jira issue move SA-423 "In Progress"')).toEqual({ key: 'SA-423', statusName: 'In Progress' });
        expect(extractIssueMoveFromCommand('jira issue move SA-423 \'QA\'')).toEqual({ key: 'SA-423', statusName: 'QA' });
        expect(extractIssueMoveFromCommand('jira issue move SA-423 Done')).toEqual({ key: 'SA-423', statusName: 'Done' });
    });

    it('matches move commands carrying global flags and trailing pipes', () => {
        expect(extractIssueMoveFromCommand('jira --as jianvis issue move DL-285 "In Progress" 2>&1 | tail -5'))
            .toEqual({ key: 'DL-285', statusName: 'In Progress' });
    });

    it('ignores non-move jira commands', () => {
        expect(extractIssueMoveFromCommand('jira issue view SA-423')).toBeNull();
        expect(extractIssueMoveFromCommand('jira issue list --plain')).toBeNull();
        expect(extractIssueMoveFromCommand('echo moved SA-423 to QA')).toBeNull();
    });
});

describe('resolveJiraIssueKeyFromTranscript', () => {
    const tempRoots: string[] = [];

    afterEach(() => {
        while (tempRoots.length > 0) {
            const root = tempRoots.pop();
            if (root) {
                fs.rmSync(root, { recursive: true, force: true });
            }
        }
    });

    function writeTranscript(lines: string[]): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-jira-transcript-'));
        tempRoots.push(root);
        const filePath = path.join(root, 'transcript.jsonl');
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
        return filePath;
    }

    it('returns null for a missing transcript path', () => {
        const { deps } = createDeps();
        expect(resolveJiraIssueKeyFromTranscript(undefined, deps)).toBeNull();
    });

    it('returns null when the transcript file does not exist', () => {
        const { deps } = createDeps();
        expect(resolveJiraIssueKeyFromTranscript('/nonexistent/transcript.jsonl', deps)).toBeNull();
    });

    it('finds a jira issue command run earlier in the session', () => {
        const filePath = writeTranscript([bashRecord('jira issue view NP-1637 --comments 50')]);
        const { deps } = createDeps();
        expect(resolveJiraIssueKeyFromTranscript(filePath, deps)).toEqual({ key: 'NP-1637', move: null });
    });

    it('returns the most recently run issue command when several appear', () => {
        // Written oldest-first, as a real transcript is append-only.
        const filePath = writeTranscript([
            bashRecord('jira issue view NA-330'),
            bashRecord('jira issue view NA-334'),
            bashRecord('jira issue view NA-335')
        ]);
        const { deps } = createDeps();
        expect(resolveJiraIssueKeyFromTranscript(filePath, deps)?.key).toBe('NA-335');
    });

    it('reports the most recent jira issue move alongside the key', () => {
        const filePath = writeTranscript([
            bashRecord('jira issue view NP-1637'),
            bashRecord('jira --as jianvis issue move NP-1637 "In Progress" 2>&1 | tail -5')
        ]);
        const { deps } = createDeps();
        expect(resolveJiraIssueKeyFromTranscript(filePath, deps)).toEqual({
            key: 'NP-1637',
            move: { key: 'NP-1637', statusName: 'In Progress' }
        });
    });

    it('keeps reporting an older move when a later command names the same issue', () => {
        const filePath = writeTranscript([
            bashRecord('jira issue move NP-1637 QA'),
            bashRecord('jira issue view NP-1637 --comments 50')
        ]);
        const { deps } = createDeps();
        expect(resolveJiraIssueKeyFromTranscript(filePath, deps)).toEqual({
            key: 'NP-1637',
            move: { key: 'NP-1637', statusName: 'QA' }
        });
    });

    it('returns the most recent move even when it targets a different issue than the key', () => {
        const filePath = writeTranscript([
            bashRecord('jira issue move NA-330 Done'),
            bashRecord('jira issue view NP-1637')
        ]);
        const { deps } = createDeps();
        expect(resolveJiraIssueKeyFromTranscript(filePath, deps)).toEqual({
            key: 'NP-1637',
            move: { key: 'NA-330', statusName: 'Done' }
        });
    });

    it('does not match jira issue list', () => {
        const filePath = writeTranscript([
            bashRecord('jira issue list --plain -q \'project = NA order by created desc\'')
        ]);
        const { deps } = createDeps();
        expect(resolveJiraIssueKeyFromTranscript(filePath, deps)).toEqual({ key: null, move: null });
    });

    it('gives up once the scan-line cap is hit', () => {
        const lines = [bashRecord('jira issue view NP-1637')];
        for (let i = 0; i < 5; i++) {
            lines.push(bashRecord(`echo turn ${i}`));
        }
        const filePath = writeTranscript(lines);

        const { deps: cappedDeps } = createDeps({ maxScanLines: 2 });
        expect(resolveJiraIssueKeyFromTranscript(filePath, cappedDeps)).toEqual({ key: null, move: null });

        const { deps: uncappedDeps } = createDeps({ maxScanLines: 100 });
        expect(resolveJiraIssueKeyFromTranscript(filePath, uncappedDeps)?.key).toBe('NP-1637');
    });

    it('gives up once the scan-byte cap is hit', () => {
        const lines = [bashRecord('jira issue view NP-1637')];
        for (let i = 0; i < 5; i++) {
            lines.push(bashRecord(`echo ${'x'.repeat(200)} ${i}`));
        }
        const filePath = writeTranscript(lines);

        const { deps: cappedDeps } = createDeps({ maxScanBytes: 300 });
        expect(resolveJiraIssueKeyFromTranscript(filePath, cappedDeps)).toEqual({ key: null, move: null });
    });

    it('caches by transcript path and size, skipping the scan on an unchanged file', () => {
        const filePath = writeTranscript([bashRecord('jira issue move NP-1637 QA')]);
        const harness = createDeps();

        expect(resolveJiraIssueKeyFromTranscript(filePath, harness.deps)).toEqual({
            key: 'NP-1637',
            move: { key: 'NP-1637', statusName: 'QA' }
        });
        expect(harness.scanCallCounter.value).toBe(1);

        expect(resolveJiraIssueKeyFromTranscript(filePath, harness.deps)).toEqual({
            key: 'NP-1637',
            move: { key: 'NP-1637', statusName: 'QA' }
        });
        expect(harness.scanCallCounter.value).toBe(1);
    });

    it('invalidates the cache once the transcript grows', () => {
        const filePath = writeTranscript([bashRecord('echo nothing here')]);
        const harness = createDeps();

        expect(resolveJiraIssueKeyFromTranscript(filePath, harness.deps)).toEqual({ key: null, move: null });
        expect(harness.scanCallCounter.value).toBe(1);

        fs.appendFileSync(filePath, `${bashRecord('jira issue view NP-1637')}\n`);

        expect(resolveJiraIssueKeyFromTranscript(filePath, harness.deps)?.key).toBe('NP-1637');
        expect(harness.scanCallCounter.value).toBe(2);
    });
});
