import * as fs from 'fs';

import { extractIssueKeyFromTitle } from './jira-issue-key';
import {
    iterateJsonlLinesReverseSync,
    parseJsonlLine
} from './jsonl-lines';
import {
    readAuxCache,
    writeAuxCache
} from './transcript-cache';

// Fourth source in the issue-key resolution chain: the issue this session is
// actually on. A slash command whose args start with a KEY, or a jira
// mutation (`move`/`edit`/`comment`/..., or jira-api.sh POST/PUT/DELETE/PATCH)
// that ran to a clean exit, most recent of those; if the session only ever
// looked (`jira issue view` / GET), the first such naming command. Later
// views of related issues do not override. The command / slash-arg context
// is proof enough that the match names a real issue, so - like the other
// sources - nothing here filters it against a project allowlist.
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
    v: 4;
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

// v1 entries predate move tracking, v2 entries counted commands that never
// succeeded, v3 entries took the most recent view as the session key; all
// three fail validation and get rescanned.
function isCachedTranscriptJiraInfo(value: unknown): value is CachedTranscriptJiraInfo {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Partial<CachedTranscriptJiraInfo>;
    return candidate.v === 4
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
const CLI_ISSUE_KEY_REGEX = new RegExp(String.raw`\bjira\s+${GLOBAL_FLAGS_PATTERN}issue\s+(\w+)\s+([A-Z][A-Z0-9]+-\d+)\b`);
// REST-script form, e.g. `./jira-api.sh get issue/NA-330`. Gated on the
// command mentioning "jira" so a bare "issue/123-abc" elsewhere can't match.
const API_SCRIPT_ISSUE_KEY_REGEX = /issue\/([A-Z][A-Z0-9]+-\d+)\b/;
const API_WRITE_METHOD_REGEX = /\b(POST|PUT|DELETE|PATCH)\b/i;

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
    if (cliMatch?.[2]) {
        return cliMatch[2];
    }

    if (/jira/i.test(command)) {
        const apiMatch = API_SCRIPT_ISSUE_KEY_REGEX.exec(command);
        if (apiMatch?.[1]) {
            return apiMatch[1];
        }
    }

    return null;
}

// A command that names an issue *and* changes it (or the session's claim on
// it): any jira-cli subcommand other than `view`, or a jira-api.sh write.
// `view` / GET are how a session looks up related tickets, so they never
// override a slash command or an earlier mutation.
export function isIntentIssueCommand(command: string): boolean {
    const cliMatch = CLI_ISSUE_KEY_REGEX.exec(command);
    if (cliMatch?.[1]) {
        return cliMatch[1].toLowerCase() !== 'view';
    }

    if (/jira/i.test(command) && API_SCRIPT_ISSUE_KEY_REGEX.test(command)) {
        return API_WRITE_METHOD_REGEX.test(command);
    }

    return false;
}

interface TranscriptUserRecord {
    isMeta?: unknown;
    isSidechain?: unknown;
    message?: { content?: unknown };
    origin?: { kind?: unknown };
    type?: unknown;
}

function userRecordText(record: TranscriptUserRecord): string | null {
    const content = record.message?.content;
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return null;
    }
    const text = (content as { type?: string; text?: unknown }[])
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text as string)
        .join(' ')
        .trim();
    return text.length > 0 ? text : null;
}

// Slash-command args use the same start-anchored KEY rule as PR titles, so
// `/i:jira-refine IM-3231` matches and `不是让你创建 skill` does not.
export function extractIssueKeyFromSlashRecord(record: unknown): string | null {
    if (typeof record !== 'object' || record === null) {
        return null;
    }
    const rec = record as TranscriptUserRecord;
    if (rec.type !== 'user' || rec.isSidechain === true || rec.isMeta === true) {
        return null;
    }
    if (rec.origin && rec.origin.kind !== 'human') {
        return null;
    }

    const text = userRecordText(rec);
    if (!text) {
        return null;
    }
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1];
    if (args === undefined) {
        return null;
    }
    return extractIssueKeyFromTitle(args.trim());
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
    id?: unknown;
    input?: { command?: unknown };
    name?: unknown;
    type?: unknown;
}

interface TranscriptToolResultBlock {
    is_error?: unknown;
    tool_use_id?: unknown;
    type?: unknown;
}

export interface BashToolUse {
    id: string;
    command: string;
}

function getMessageContentBlocks(record: unknown): unknown[] {
    if (typeof record !== 'object' || record === null) {
        return [];
    }
    const content = (record as { message?: { content?: unknown } }).message?.content;
    return Array.isArray(content) ? content as unknown[] : [];
}

// A Bash call carries its id so the result record that decides whether it
// counted can be matched back to it.
export function extractBashToolUses(record: unknown): BashToolUse[] {
    const toolUses: BashToolUse[] = [];
    for (const block of getMessageContentBlocks(record)) {
        if (typeof block !== 'object' || block === null) {
            continue;
        }
        const toolUse = block as TranscriptToolUseBlock;
        if (toolUse.type === 'tool_use'
            && toolUse.name === 'Bash'
            && typeof toolUse.id === 'string'
            && typeof toolUse.input?.command === 'string') {
            toolUses.push({ id: toolUse.id, command: toolUse.input.command });
        }
    }
    return toolUses;
}

// A command counts only once its result record says it ran and exited
// cleanly: a nonzero exit, a denied permission prompt and a tool error all
// land as is_error, and an interrupted command stops mid-run, so none of
// them proves the jira command took effect. A result record that never
// arrives - the command is still running, or the session died mid-call -
// leaves the id out of the set, which is the same answer.
export function collectSucceededToolUseIds(record: unknown, into: Set<string>): void {
    const toolUseResult = typeof record === 'object' && record !== null
        ? (record as { toolUseResult?: unknown }).toolUseResult
        : undefined;
    const interrupted = typeof toolUseResult === 'object' && toolUseResult !== null
        && (toolUseResult as { interrupted?: unknown }).interrupted === true;

    for (const block of getMessageContentBlocks(record)) {
        if (typeof block !== 'object' || block === null) {
            continue;
        }
        const toolResult = block as TranscriptToolResultBlock;
        if (toolResult.type === 'tool_result'
            && typeof toolResult.tool_use_id === 'string'
            && toolResult.is_error !== true
            && !interrupted) {
            into.add(toolResult.tool_use_id);
        }
    }
}

function scanTranscriptForJiraInfo(transcriptPath: string, deps: JiraTranscriptKeyDeps): TranscriptJiraInfo {
    let scannedLines = 0;
    let scannedBytes = 0;
    // Most recent slash command or successful mutation, found first in reverse.
    let intentKey: string | null = null;
    // Overwritten on every naming hit; after a reverse scan this is the oldest
    // one in the window, used only when the session never declared intent.
    let oldestNamingKey: string | null = null;
    let move: JiraIssueMove | null = null;
    // The reverse scan reaches a command's result record before the command
    // itself, so by the time a Bash call is read its outcome is already known.
    const succeededToolUseIds = new Set<string>();

    try {
        for (const line of deps.iterateJsonlLinesReverseSync(transcriptPath)) {
            if (scannedLines >= deps.maxScanLines || scannedBytes >= deps.maxScanBytes) {
                break;
            }
            // Views still have to walk back to the oldest naming command, so
            // we only stop early once intent (slash/mutation) and a move are
            // both known. A session with intent and no move keeps scanning
            // for a move; a view-only session scans to the cap.
            if (intentKey !== null && move !== null) {
                break;
            }
            scannedLines++;
            scannedBytes += line.length;

            const record = parseJsonlLine(line);
            collectSucceededToolUseIds(record, succeededToolUseIds);

            const slashKey = extractIssueKeyFromSlashRecord(record);
            if (slashKey) {
                oldestNamingKey = slashKey;
                intentKey ??= slashKey;
            }

            for (const toolUse of extractBashToolUses(record)) {
                if (!succeededToolUseIds.has(toolUse.id)) {
                    continue;
                }
                move ??= extractIssueMoveFromCommand(toolUse.command);
                const commandKey = extractIssueKeyFromCommand(toolUse.command);
                if (!commandKey) {
                    continue;
                }
                oldestNamingKey = commandKey;
                if (isIntentIssueCommand(toolUse.command)) {
                    intentKey ??= commandKey;
                }
            }
        }
    } catch {
        return { key: null, move: null };
    }

    return { key: intentKey ?? oldestNamingKey, move };
}

// Reads the session's issue key - and the most recent successful
// `jira issue move` - from the transcript. Cached per (transcript path,
// transcript size) so an idle session (no new records since the last
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
    deps.writeAuxCache(AUX_CACHE_PREFIX, cacheKey, { v: 4, ...info });
    return info;
}
