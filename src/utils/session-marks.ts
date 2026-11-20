import * as fs from 'fs';
import * as path from 'path';

import { getClaudeConfigDir } from './claude-settings';

// What an agent declared about its own session with `ccstatusline mark`, for
// the widgets that otherwise infer the same facts. Lives beside the session's
// other sidecars, so it is deleted with the transcripts.
export interface SessionMarks {
    jira?: { key: string; ts: number };
    dev?: { url: string; ts: number };
}

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

// `<project>/<session-id>/marks.json`; a subagent's transcript, under
// `<session-id>/subagents/`, maps to the same session directory.
export function marksPathFromTranscript(transcriptPath: string): string {
    const resolved = path.resolve(transcriptPath);
    const dir = path.dirname(resolved);
    const sessionDir = path.basename(dir) === 'subagents'
        ? path.dirname(dir)
        : path.join(dir, path.basename(resolved, path.extname(resolved)));
    return path.join(sessionDir, 'marks.json');
}

export function readSessionMarks(transcriptPath: string | undefined): SessionMarks {
    if (!transcriptPath)
        return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(marksPathFromTranscript(transcriptPath), 'utf8'));
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object')
        return {};
    const raw = parsed as { jira?: { key?: unknown; ts?: unknown }; dev?: { url?: unknown; ts?: unknown } };
    const marks: SessionMarks = {};
    if (typeof raw.jira?.key === 'string' && ISSUE_KEY.test(raw.jira.key) && typeof raw.jira.ts === 'number')
        marks.jira = { key: raw.jira.key, ts: raw.jira.ts };
    if (typeof raw.dev?.url === 'string' && parseDevUrl(raw.dev.url) && typeof raw.dev.ts === 'number')
        marks.dev = { url: raw.dev.url, ts: raw.dev.ts };
    return marks;
}

function writeSessionMarks(transcriptPath: string, marks: SessionMarks): void {
    const file = marksPathFromTranscript(transcriptPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Status lines read this while it is written; a rename never shows half a file.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(marks));
    fs.renameSync(tmp, file);
}

export function parseDevUrl(raw: string): URL | null {
    try {
        const url = new URL(raw);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
    } catch {
        return null;
    }
}

// Addresses only this machine can be serving, so whether anything listens on
// the port is something the kernel can answer. Dev servers bound to all
// interfaces print the wildcard address.
export function isLoopbackUrl(url: URL): boolean {
    const host = url.hostname;
    return host === 'localhost' || host === '[::1]' || host === '0.0.0.0' || host === '[::]' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export function urlPort(url: URL): number {
    if (url.port)
        return Number.parseInt(url.port, 10);
    return url.protocol === 'https:' ? 443 : 80;
}

// Claude Code gives every Bash call its session id; the transcript named after
// it sits in exactly one project directory.
export function findTranscriptForSession(sessionId: string, configDir = getClaudeConfigDir()): string | null {
    const projectsDir = path.join(configDir, 'projects');
    let projects: string[];
    try {
        projects = fs.readdirSync(projectsDir);
    } catch {
        return null;
    }
    for (const project of projects) {
        const candidate = path.join(projectsDir, project, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate))
            return candidate;
    }
    return null;
}

export interface MarkCommandResult {
    exitCode: number;
    message: string;
    // Set when a dev mark changed, so the caller can resolve it right away.
    transcriptPath?: string;
    devChanged?: boolean;
}

export const MARK_USAGE = [
    'usage: ccstatusline mark jira <ISSUE-KEY>   show this issue in the jira-issue widget',
    '       ccstatusline mark dev <URL>          show this dev server in the dev-server widget',
    '       ccstatusline mark clear [jira|dev]   drop one mark, or both',
    'Run inside a Claude Code session: the mark belongs to $CLAUDE_CODE_SESSION_ID.'
].join('\n');

export interface MarkCommandDeps {
    env: NodeJS.ProcessEnv;
    findTranscriptForSession: typeof findTranscriptForSession;
    now: () => number;
}

const DEFAULT_MARK_DEPS: MarkCommandDeps = {
    env: process.env,
    findTranscriptForSession,
    now: Date.now
};

export function runMarkCommand(args: string[], deps: MarkCommandDeps = DEFAULT_MARK_DEPS): MarkCommandResult {
    const [kind, value, extra] = args;
    const usage = (problem: string): MarkCommandResult => ({ exitCode: 2, message: `${problem}\n${MARK_USAGE}` });

    if (extra !== undefined)
        return usage(`unexpected argument: ${extra}`);

    let next: (marks: SessionMarks) => SessionMarks;
    let done: string;
    let devChanged = false;
    if (kind === 'jira') {
        const key = value?.toUpperCase();
        if (!key || !ISSUE_KEY.test(key))
            return usage(`not an issue key: ${value ?? '(missing)'}`);
        next = marks => ({ ...marks, jira: { key, ts: deps.now() } });
        done = `jira-issue now shows ${key}`;
    } else if (kind === 'dev') {
        const url = value ? parseDevUrl(value) : null;
        if (!url)
            return usage(`not an http(s) URL: ${value ?? '(missing)'}`);
        next = marks => ({ ...marks, dev: { url: url.href, ts: deps.now() } });
        done = isLoopbackUrl(url)
            ? `dev-server shows ${url.href} while something listens on port ${urlPort(url)}`
            : `dev-server now shows ${url.href}`;
        devChanged = true;
    } else if (kind === 'clear') {
        if (value !== undefined && value !== 'jira' && value !== 'dev')
            return usage(`clear takes jira, dev or nothing, not: ${value}`);
        next = (marks) => {
            if (value === undefined)
                return {};
            const { [value]: _dropped, ...rest } = marks;
            return rest;
        };
        done = value ? `cleared the ${value} mark` : 'cleared all marks';
        devChanged = value !== 'jira';
    } else {
        return usage(kind ? `unknown mark: ${kind}` : 'missing what to mark');
    }

    const sessionId = deps.env.CLAUDE_CODE_SESSION_ID;
    if (!sessionId)
        return { exitCode: 1, message: 'CLAUDE_CODE_SESSION_ID is not set: run this from a Bash call inside a Claude Code session.' };
    const transcriptPath = deps.findTranscriptForSession(sessionId);
    if (!transcriptPath)
        return { exitCode: 1, message: `no transcript found for session ${sessionId}` };

    writeSessionMarks(transcriptPath, next(readSessionMarks(transcriptPath)));
    return { exitCode: 0, message: done, transcriptPath, devChanged };
}
