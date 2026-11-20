import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import {
    findTranscriptForSession,
    readSessionMarks,
    runMarkCommand
} from '../session-marks';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

describe('ccstatusline mark', () => {
    let configDir: string;
    let transcript: string;

    beforeEach(() => {
        configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-marks-'));
        const project = path.join(configDir, 'projects', '-Users-me-repo');
        fs.mkdirSync(project, { recursive: true });
        transcript = path.join(project, `${SESSION_ID}.jsonl`);
        fs.writeFileSync(transcript, '');
    });

    afterEach(() => {
        fs.rmSync(configDir, { recursive: true, force: true });
    });

    function mark(...args: string[]) {
        return runMarkCommand(args, {
            env: { CLAUDE_CODE_SESSION_ID: SESSION_ID },
            findTranscriptForSession: id => findTranscriptForSession(id, configDir),
            now: () => 1000
        });
    }

    it('records the issue for the session that ran it, upper-cased', () => {
        expect(mark('jira', 'im-3242').exitCode).toBe(0);
        expect(readSessionMarks(transcript).jira?.key).toBe('IM-3242');
    });

    it('is visible from a subagent transcript of the same session', () => {
        mark('jira', 'IM-1');
        const subagent = path.join(path.dirname(transcript), SESSION_ID, 'subagents', 'agent-abc.jsonl');
        expect(readSessionMarks(subagent).jira?.key).toBe('IM-1');
    });

    it('stores a dev URL in the form the dev-server widget prints', () => {
        mark('dev', 'http://localhost:5173');
        expect(readSessionMarks(transcript).dev?.url).toBe('http://localhost:5173/');
    });

    it('clears one mark and keeps the other', () => {
        mark('jira', 'IM-1');
        mark('dev', 'http://localhost:5173/');
        mark('clear', 'jira');
        expect(readSessionMarks(transcript)).toEqual({ dev: { url: 'http://localhost:5173/', ts: 1000 } });
        mark('clear');
        expect(readSessionMarks(transcript)).toEqual({});
    });

    it('rejects what is not an issue key and leaves the marks alone', () => {
        mark('jira', 'IM-1');
        const result = mark('jira', 'fix-login');
        expect(result.exitCode).toBe(2);
        expect(result.message).toContain('usage:');
        expect(readSessionMarks(transcript).jira?.key).toBe('IM-1');
    });

    it('rejects a URL that is not http(s)', () => {
        expect(mark('dev', 'localhost:5173').exitCode).toBe(2);
        expect(readSessionMarks(transcript).dev).toBeUndefined();
    });

    it('fails outside a Claude Code session', () => {
        const result = runMarkCommand(['jira', 'IM-1'], {
            env: {},
            findTranscriptForSession: id => findTranscriptForSession(id, configDir),
            now: () => 1000
        });
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain('CLAUDE_CODE_SESSION_ID');
    });
});
