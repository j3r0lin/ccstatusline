import * as fs from 'fs';

import {
    iterateJsonlLinesReverseSync,
    parseJsonlLine
} from './jsonl-lines';
import {
    readAuxCache,
    writeAuxCache
} from './transcript-cache';

// Fourth source in the issue-key resolution chain: a `jira issue <cmd> <KEY>`
// (or jira-api.sh `issue/<KEY>`) command the current session actually ran,
// most recent first. The command context is proof enough that the match
// names a real issue, so - like the other sources - nothing here filters it
// against a project allowlist.
const AUX_CACHE_PREFIX = 'jira-transcript-issue';

// Bound the worst-case scan: most sessions never run a jira command, so
// without a cap a cache miss (right after a new transcript record lands)
// would pay for a full reverse scan of a potentially huge transcript on
// every render. 4000 records comfortably covers a long single-topic working
// session; the 8MB byte cap protects against a handful of records with large
// embedded tool output/images ballooning scan cost without many records.
export const DEFAULT_MAX_SCAN_LINES = 4000;
export const DEFAULT_MAX_SCAN_BYTES = 8 * 1024 * 1024;

export interface JiraTranscriptKeyDeps {
    iterateJsonlLinesReverseSync: typeof iterateJsonlLinesReverseSync;
    maxScanBytes: number;
    maxScanLines: number;
    readAuxCache: typeof readAuxCache;
    statSync: typeof fs.statSync;
    writeAuxCache: typeof writeAuxCache;
}

const DEFAULT_JIRA_TRANSCRIPT_KEY_DEPS: JiraTranscriptKeyDeps = {
    iterateJsonlLinesReverseSync,
    maxScanBytes: DEFAULT_MAX_SCAN_BYTES,
    maxScanLines: DEFAULT_MAX_SCAN_LINES,
    readAuxCache,
    statSync: fs.statSync,
    writeAuxCache
};

interface CachedTranscriptJiraInfo {
    v: 2;
    key: string | null;
    move: JiraIssueMove | null;
}

function isJiraIssueMove(value: unknown): value is JiraIssueMove {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Partial<JiraIssueMove>;
    return typeof candidate.key === 'string' && typeof candidate.statusName === 'string';
}

// v1 entries predate move tracking; they fail validation and get rescanned.
function isCachedTranscriptJiraInfo(value: unknown): value is CachedTranscriptJiraInfo {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Partial<CachedTranscriptJiraInfo>;
    return candidate.v === 2
        && (candidate.key === null || typeof candidate.key === 'string')
        && (candidate.move === null || isJiraIssueMove(candidate.move));
}

// Global flags may sit between `jira` and the subcommand, e.g.
// `jira --as jianvis issue move DL-285 "In Progress"`. Each flag may carry
// an inline value (`--as=jianvis`), one value token (`--as jianvis`), or
// none; when a flag takes no value, backtracking leaves the following
// `issue` for the literal match instead of swallowing it as the value.
const GLOBAL_FLAGS_PATTERN = String.raw`(?:--?[\w-]+(?:=\S+)?(?:\s+(?!-)\S+)?\s+)*`;

// A jira-cli subcommand that names a specific issue: `view`/`edit`/`comment`/
// `move`/... followed immediately by a KEY. `jira issue list ...` never
// matches because its next token (a flag like --plain, or a JQL string) never
// has the KEY shape.
const CLI_ISSUE_KEY_REGEX = new RegExp(String.raw`\bjira\s+${GLOBAL_FLAGS_PATTERN}issue\s+\w+\s+([A-Z][A-Z0-9]+-\d+)\b`);
// REST-script form, e.g. `./jira-api.sh get issue/NA-330`. Gated on the
// command mentioning "jira" so a bare "issue/123-abc" elsewhere can't match.
const API_SCRIPT_ISSUE_KEY_REGEX = /issue\/([A-Z][A-Z0-9]+-\d+)\b/;

// `jira issue move KEY "New Status"` - the status argument may be double- or
// single-quoted, or a bare single word. The widget uses this to recolor the
// issue the moment a session moves it, without waiting out the status-cache
// TTL.
const CLI_ISSUE_MOVE_REGEX = new RegExp(String.raw`\bjira\s+${GLOBAL_FLAGS_PATTERN}issue\s+move\s+([A-Z][A-Z0-9]+-\d+)\s+(?:"([^"]+)"|'([^']+)'|(\S+))`);

export interface JiraIssueMove {
    key: string;
    statusName: string;
}

export interface TranscriptJiraInfo {
    key: string | null;
    move: JiraIssueMove | null;
}

export function extractIssueKeyFromCommand(command: string): string | null {
    const cliMatch = CLI_ISSUE_KEY_REGEX.exec(command);
    if (cliMatch?.[1]) {
        return cliMatch[1];
    }

    if (/jira/i.test(command)) {
        const apiMatch = API_SCRIPT_ISSUE_KEY_REGEX.exec(command);
        if (apiMatch?.[1]) {
            return apiMatch[1];
        }
    }

    return null;
}

export function extractIssueMoveFromCommand(command: string): JiraIssueMove | null {
    const match = CLI_ISSUE_MOVE_REGEX.exec(command);
    const key = match?.[1];
    const statusName = match?.[2] ?? match?.[3] ?? match?.[4];
    if (!key || !statusName) {
        return null;
    }
    return { key, statusName };
}

interface TranscriptToolUseBlock {
    input?: { command?: unknown };
    name?: unknown;
    type?: unknown;
}

function extractBashCommands(record: unknown): string[] {
    if (typeof record !== 'object' || record === null) {
        return [];
    }
    const content = (record as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) {
        return [];
    }

    const commands: string[] = [];
    for (const block of content as unknown[]) {
        if (typeof block !== 'object' || block === null) {
            continue;
        }
        const toolUse = block as TranscriptToolUseBlock;
        if (toolUse.type === 'tool_use' && toolUse.name === 'Bash' && typeof toolUse.input?.command === 'string') {
            commands.push(toolUse.input.command);
        }
    }
    return commands;
}

function scanTranscriptForJiraInfo(transcriptPath: string, deps: JiraTranscriptKeyDeps): TranscriptJiraInfo {
    let scannedLines = 0;
    let scannedBytes = 0;
    let key: string | null = null;
    let move: JiraIssueMove | null = null;

    try {
        for (const line of deps.iterateJsonlLinesReverseSync(transcriptPath)) {
            if (scannedLines >= deps.maxScanLines || scannedBytes >= deps.maxScanBytes) {
                break;
            }
            if (key !== null && move !== null) {
                break;
            }
            scannedLines++;
            scannedBytes += line.length;

            for (const command of extractBashCommands(parseJsonlLine(line))) {
                move ??= extractIssueMoveFromCommand(command);
                key ??= extractIssueKeyFromCommand(command);
            }
        }
    } catch {
        return { key: null, move: null };
    }

    return { key, move };
}

// Reads the most recently run jira-issue-naming command - and the most recent
// `jira issue move` - from the session transcript. Cached per (transcript
// path, transcript size) so an idle session (no new records since the last
// render) never re-scans, while a growing transcript naturally invalidates
// the cache instead of needing an explicit TTL.
export function resolveJiraIssueKeyFromTranscript(
    transcriptPath: string | undefined,
    deps: JiraTranscriptKeyDeps = DEFAULT_JIRA_TRANSCRIPT_KEY_DEPS
): TranscriptJiraInfo | null {
    if (!transcriptPath) {
        return null;
    }

    let size: number;
    try {
        size = deps.statSync(transcriptPath).size;
    } catch {
        return null;
    }

    const cacheKey = `${transcriptPath}::${size}`;
    const cached = deps.readAuxCache(AUX_CACHE_PREFIX, cacheKey);
    if (isCachedTranscriptJiraInfo(cached)) {
        return { key: cached.key, move: cached.move };
    }

    const info = scanTranscriptForJiraInfo(transcriptPath, deps);
    deps.writeAuxCache(AUX_CACHE_PREFIX, cacheKey, { v: 2, ...info });
    return info;
}
