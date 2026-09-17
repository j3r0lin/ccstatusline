import chalk from 'chalk';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it
} from 'vitest';

import type { RenderContext } from '../../types/RenderContext';
import {
    DEFAULT_SETTINGS,
    type Settings
} from '../../types/Settings';
import type { WidgetItem } from '../../types/Widget';
import { stripSgrCodes } from '../../utils/ansi';
import { updateColorMap } from '../../utils/colors';
import { renderOsc8Link } from '../../utils/hyperlink';
import type { JiraIssueStatus } from '../../utils/jira-issue-cache';
import type { ResolvedJiraIssueKey } from '../../utils/jira-issue-key';
import {
    JiraIssueWidget,
    type JiraIssueWidgetDeps
} from '../JiraIssue';

const SERVER = 'https://jira.example.com';

// Mirror the runtime colorLevel so getColorAnsiCode actually emits SGR codes
// (chalk defaults to level 0 in tests, which would silently drop all color).
let originalChalkLevel: typeof chalk.level;
beforeAll(() => {
    originalChalkLevel = chalk.level;
    chalk.level = 2;
    updateColorMap();
});
afterAll(() => {
    chalk.level = originalChalkLevel;
    updateColorMap();
});

function createDeps(overrides: Partial<JiraIssueWidgetDeps> = {}): JiraIssueWidgetDeps {
    return {
        applyJiraIssueMoveToCache: (key, statusName) => ({ key, statusName, statusCategoryKey: '' }),
        getCachedGitReviewData: () => null,
        getCachedJiraIssueStatus: () => null,
        getProcessCwd: () => '/tmp/process-cwd',
        isInsideGitWorkTree: () => true,
        readJiraCliConfig: () => ({ server: SERVER }),
        resolveGitCwd: context => context.data?.cwd,
        resolveJiraIssueKey: () => null,
        resolveJiraIssueKeyFromTranscript: () => null,
        ...overrides
    };
}

function render(
    options: {
        cwd?: string;
        hide?: string;
        isPreview?: boolean;
        settings?: Settings;
        transcriptPath?: string;
    } = {},
    depOverrides: Partial<JiraIssueWidgetDeps> = {},
    itemOverrides: Partial<WidgetItem> = {}
): string | null {
    const widget = new JiraIssueWidget(createDeps(depOverrides));
    const context: RenderContext = {
        data: options.cwd ?? options.transcriptPath
            ? { cwd: options.cwd, transcript_path: options.transcriptPath }
            : undefined,
        isPreview: options.isPreview
    };
    const metadata: Record<string, string> = {};
    if (options.hide !== undefined) {
        metadata.hide = options.hide;
    }

    const item: WidgetItem = {
        id: 'jira-issue',
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        type: 'jira-issue',
        ...itemOverrides
    };

    return widget.render(item, context, options.settings ?? DEFAULT_SETTINGS);
}

describe('JiraIssueWidget', () => {
    it('renders a clickable key with no color when preview has no status color applicable', () => {
        const result = render({ isPreview: true });
        expect(result).toContain(renderOsc8Link(`${SERVER}/browse/IM-3299`, 'IM-3299'));
    });

    it('returns (no issue) when not in a git repo', () => {
        expect(stripSgrCodes(render({}, { isInsideGitWorkTree: () => false }) ?? '')).toBe('(no issue)');
    });

    it('returns null when not in a git repo and no-issue is hidden', () => {
        expect(render({ hide: 'no-issue' }, { isInsideGitWorkTree: () => false })).toBeNull();
    });

    it('returns (no issue) when the resolution chain finds no key', () => {
        expect(stripSgrCodes(render({ cwd: '/tmp/repo' }, { resolveJiraIssueKey: () => null }) ?? '')).toBe('(no issue)');
    });

    it('renders the resolved key as a clickable link to <server>/browse/<KEY>', () => {
        const resolved: ResolvedJiraIssueKey = { key: 'IM-3299', source: 'branch-name' };
        const result = render({ cwd: '/tmp/repo' }, { resolveJiraIssueKey: () => resolved });
        expect(result).toContain(renderOsc8Link(`${SERVER}/browse/IM-3299`, 'IM-3299'));
    });

    it('shows the plain key with no link when the server is unknown', () => {
        const resolved: ResolvedJiraIssueKey = { key: 'IM-3299', source: 'branch-name' };
        const result = render({ cwd: '/tmp/repo' }, {
            readJiraCliConfig: () => ({}),
            resolveJiraIssueKey: () => resolved
        });
        expect(stripSgrCodes(result ?? '')).toBe('IM-3299');
    });

    it('colors QA/done by status name, not the done statusCategory fallback', () => {
        const resolved: ResolvedJiraIssueKey = { key: 'IM-3299', source: 'branch-name' };
        const status: JiraIssueStatus = { key: 'IM-3299', statusName: 'QA', statusCategoryKey: 'done' };
        const result = render({ cwd: '/tmp/repo' }, {
            getCachedJiraIssueStatus: () => status,
            resolveJiraIssueKey: () => resolved
        });
        // brightCyan (QA's mapped color), not brightGreen (done's category fallback)
        expect(result).toContain('\x1b[38;5;80m');
        expect(result).not.toContain('\x1b[38;5;155m');
    });

    it('falls back to the statusCategory color when the status name is unmapped', () => {
        const resolved: ResolvedJiraIssueKey = { key: 'IM-1', source: 'branch-name' };
        const status: JiraIssueStatus = { key: 'IM-1', statusName: 'Custom Review', statusCategoryKey: 'indeterminate' };
        const result = render({ cwd: '/tmp/repo' }, {
            getCachedJiraIssueStatus: () => status,
            resolveJiraIssueKey: () => resolved
        });
        expect(result).toContain('\x1b[38;5;227m');
    });

    it('honors a settings.jira.statusColors override for a status name', () => {
        const resolved: ResolvedJiraIssueKey = { key: 'IM-3299', source: 'branch-name' };
        const status: JiraIssueStatus = { key: 'IM-3299', statusName: 'QA', statusCategoryKey: 'done' };
        const result = render({
            cwd: '/tmp/repo',
            settings: { ...DEFAULT_SETTINGS, jira: { statusColors: { QA: 'magenta' } } }
        }, {
            getCachedJiraIssueStatus: () => status,
            resolveJiraIssueKey: () => resolved
        });
        expect(result).toContain('\x1b[38;5;96m');
    });

    // The renderer withholds its own foreground while colorByStatus is on, so an
    // unknown status must still come out in the item's configured color rather
    // than on the terminal default.
    it('falls back to the configured color when the jira CLI has no cached status', () => {
        const resolved: ResolvedJiraIssueKey = { key: 'IM-3299', source: 'branch-name' };
        const result = render({ cwd: '/tmp/repo' }, {
            getCachedJiraIssueStatus: () => null,
            resolveJiraIssueKey: () => resolved
        }, { color: 'magenta' });
        expect(stripSgrCodes(result ?? '')).toBe(renderOsc8Link(`${SERVER}/browse/IM-3299`, 'IM-3299'));
        expect(result).toContain('\x1b[38;5;96m');
    });

    it('falls back to the default color when the item has no configured color', () => {
        const resolved: ResolvedJiraIssueKey = { key: 'IM-3299', source: 'branch-name' };
        const result = render({ cwd: '/tmp/repo' }, {
            getCachedJiraIssueStatus: () => null,
            resolveJiraIssueKey: () => resolved
        });
        expect(result).toContain('\x1b[38;5;188m');
    });

    it('skips coloring entirely when colorByStatus is toggled off', () => {
        const resolved: ResolvedJiraIssueKey = { key: 'IM-3299', source: 'branch-name' };
        const status: JiraIssueStatus = { key: 'IM-3299', statusName: 'QA', statusCategoryKey: 'done' };
        const result = render({ cwd: '/tmp/repo' }, {
            getCachedJiraIssueStatus: () => status,
            resolveJiraIssueKey: () => resolved
        }, { metadata: { colorByStatus: 'false' } });
        expect(result).toBe(renderOsc8Link(`${SERVER}/browse/IM-3299`, 'IM-3299'));
    });

    it('reports preservesRenderedColors/supportsColors flipped by the colorByStatus toggle', () => {
        const widget = new JiraIssueWidget(createDeps());
        const onItem: WidgetItem = { id: '1', type: 'jira-issue' };
        const offItem: WidgetItem = { id: '1', type: 'jira-issue', metadata: { colorByStatus: 'false' } };

        expect(widget.preservesRenderedColors(onItem)).toBe(true);
        expect(widget.supportsColors(onItem)).toBe(false);
        expect(widget.preservesRenderedColors(offItem)).toBe(false);
        expect(widget.supportsColors(offItem)).toBe(true);
    });

    it('prefixes the Jira icon only when the icon toggle is on', () => {
        const resolved: ResolvedJiraIssueKey = { key: 'IM-3299', source: 'branch-name' };
        const withIconResult = render({ cwd: '/tmp/repo' }, { resolveJiraIssueKey: () => resolved }, { metadata: { icon: 'true' } });
        const withoutIconResult = render({ cwd: '/tmp/repo' }, { resolveJiraIssueKey: () => resolved });

        expect(stripSgrCodes(withIconResult ?? '')).toBe(`\u{f802} ${renderOsc8Link(`${SERVER}/browse/IM-3299`, 'IM-3299')}`);
        expect(withoutIconResult).not.toContain('\u{f802}');
    });

    it('declares the no-issue hideable state', () => {
        expect(new JiraIssueWidget(createDeps()).getHideableStates().map(state => state.key)).toEqual(['no-issue']);
    });

    it('passes the cached PR/MR title through to the resolution chain', () => {
        const calls: unknown[] = [];
        render({ cwd: '/tmp/repo' }, {
            getCachedGitReviewData: () => ({
                number: 1,
                reviewDecision: '',
                state: 'OPEN',
                title: 'fix(widget): resolve IM-3299',
                url: 'https://example.com/pr/1'
            }),
            resolveJiraIssueKey: (params) => {
                calls.push(params);
                return null;
            }
        });
        expect(calls).toEqual([{
            cwd: '/tmp/repo',
            prTitle: 'fix(widget): resolve IM-3299',
            transcriptIssueKey: null
        }]);
    });

    it('passes the transcript-resolved key through to the resolution chain', () => {
        const calls: unknown[] = [];
        render({ cwd: '/tmp/repo', transcriptPath: '/tmp/transcript.jsonl' }, {
            resolveJiraIssueKeyFromTranscript: (transcriptPath) => {
                expect(transcriptPath).toBe('/tmp/transcript.jsonl');
                return { key: 'NP-1637', move: null };
            },
            resolveJiraIssueKey: (params) => {
                calls.push(params.transcriptIssueKey);
                return null;
            }
        });
        expect(calls).toEqual(['NP-1637']);
    });

    it('recolors from a transcript jira issue move ahead of the stale status cache', () => {
        const resolved: ResolvedJiraIssueKey = { key: 'IM-3299', source: 'branch-name' };
        const staleStatus: JiraIssueStatus = { key: 'IM-3299', statusName: 'In Progress', statusCategoryKey: 'indeterminate' };
        const applied: { key: string; statusName: string }[] = [];

        const result = render({ cwd: '/tmp/repo', transcriptPath: '/tmp/transcript.jsonl' }, {
            applyJiraIssueMoveToCache: (key, statusName) => {
                applied.push({ key, statusName });
                return { key, statusName, statusCategoryKey: '' };
            },
            getCachedJiraIssueStatus: () => staleStatus,
            resolveJiraIssueKey: () => resolved,
            resolveJiraIssueKeyFromTranscript: () => ({ key: 'IM-3299', move: { key: 'IM-3299', statusName: 'QA' } })
        });

        expect(applied).toEqual([{ key: 'IM-3299', statusName: 'QA' }]);
        // brightCyan (QA), not brightYellow (the cache's stale In Progress)
        expect(result).toContain('\x1b[38;5;80m');
        expect(result).not.toContain('\x1b[38;5;227m');
    });

    it('ignores a transcript move that targets a different issue', () => {
        const resolved: ResolvedJiraIssueKey = { key: 'IM-3299', source: 'branch-name' };
        const status: JiraIssueStatus = { key: 'IM-3299', statusName: 'In Progress', statusCategoryKey: 'indeterminate' };
        let applied = 0;

        const result = render({ cwd: '/tmp/repo', transcriptPath: '/tmp/transcript.jsonl' }, {
            applyJiraIssueMoveToCache: (key, statusName) => {
                applied++;
                return { key, statusName, statusCategoryKey: '' };
            },
            getCachedJiraIssueStatus: () => status,
            resolveJiraIssueKey: () => resolved,
            resolveJiraIssueKeyFromTranscript: () => ({ key: 'IM-3299', move: { key: 'OTHER-1', statusName: 'QA' } })
        });

        expect(applied).toBe(0);
        expect(result).toContain('\x1b[38;5;227m');
    });

    it('leaves the cache alone when it already shows the moved-to status', () => {
        const resolved: ResolvedJiraIssueKey = { key: 'IM-3299', source: 'branch-name' };
        const status: JiraIssueStatus = { key: 'IM-3299', statusName: 'QA', statusCategoryKey: 'done' };
        let applied = 0;

        const result = render({ cwd: '/tmp/repo', transcriptPath: '/tmp/transcript.jsonl' }, {
            applyJiraIssueMoveToCache: (key, statusName) => {
                applied++;
                return { key, statusName, statusCategoryKey: '' };
            },
            getCachedJiraIssueStatus: () => status,
            resolveJiraIssueKey: () => resolved,
            resolveJiraIssueKeyFromTranscript: () => ({ key: 'IM-3299', move: { key: 'IM-3299', statusName: 'QA' } })
        });

        expect(applied).toBe(0);
        expect(result).toContain('\x1b[38;5;80m');
    });
});
