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
import type { SessionMarks } from '../../utils/session-marks';
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
        getCachedJiraIssueStatus: () => null,
        readJiraCliConfig: () => ({ server: SERVER }),
        readSessionMarks: () => ({}),
        ...overrides
    };
}

const MARKED: SessionMarks = { jira: { key: 'IM-3299', ts: 1 } };

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

    it('returns (no issue) when the session marked no issue', () => {
        expect(stripSgrCodes(render({ cwd: '/tmp/repo' }) ?? '')).toBe('(no issue)');
    });

    it('returns null when the session marked no issue and no-issue is hidden', () => {
        expect(render({ cwd: '/tmp/repo', hide: 'no-issue' })).toBeNull();
    });

    it('shows the issue marked for the transcript it renders', () => {
        const result = render({ transcriptPath: '/tmp/transcript.jsonl' }, { readSessionMarks: transcriptPath => transcriptPath === '/tmp/transcript.jsonl' ? { jira: { key: 'IM-42', ts: 1 } } : {} });
        expect(stripSgrCodes(result ?? '')).toBe(renderOsc8Link(`${SERVER}/browse/IM-42`, 'IM-42'));
    });

    it('renders the marked key as a clickable link to <server>/browse/<KEY>', () => {
        const result = render({ cwd: '/tmp/repo' }, { readSessionMarks: () => MARKED });
        expect(result).toContain(renderOsc8Link(`${SERVER}/browse/IM-3299`, 'IM-3299'));
    });

    it('shows the plain key with no link when the server is unknown', () => {
        const result = render({ cwd: '/tmp/repo' }, {
            readJiraCliConfig: () => ({}),
            readSessionMarks: () => MARKED
        });
        expect(stripSgrCodes(result ?? '')).toBe('IM-3299');
    });

    it('colors QA/done by status name, not the done statusCategory fallback', () => {
        const status: JiraIssueStatus = { key: 'IM-3299', statusName: 'QA', statusCategoryKey: 'done' };
        const result = render({ cwd: '/tmp/repo' }, {
            getCachedJiraIssueStatus: () => status,
            readSessionMarks: () => MARKED
        });
        // brightCyan (QA's mapped color), not brightGreen (done's category fallback)
        expect(result).toContain('\x1b[38;5;80m');
        expect(result).not.toContain('\x1b[38;5;155m');
    });

    it('falls back to the statusCategory color when the status name is unmapped', () => {
        const status: JiraIssueStatus = { key: 'IM-1', statusName: 'Custom Review', statusCategoryKey: 'indeterminate' };
        const result = render({ cwd: '/tmp/repo' }, {
            getCachedJiraIssueStatus: () => status,
            readSessionMarks: () => MARKED
        });
        expect(result).toContain('\x1b[38;5;227m');
    });

    it('honors a settings.jira.statusColors override for a status name', () => {
        const status: JiraIssueStatus = { key: 'IM-3299', statusName: 'QA', statusCategoryKey: 'done' };
        const result = render({
            cwd: '/tmp/repo',
            settings: { ...DEFAULT_SETTINGS, jira: { statusColors: { QA: 'magenta' } } }
        }, {
            getCachedJiraIssueStatus: () => status,
            readSessionMarks: () => MARKED
        });
        expect(result).toContain('\x1b[38;5;96m');
    });

    // The renderer withholds its own foreground while colorByStatus is on, so an
    // unknown status must still come out in the item's configured color rather
    // than on the terminal default.
    it('falls back to the configured color when the jira CLI has no cached status', () => {
        const result = render({ cwd: '/tmp/repo' }, {
            getCachedJiraIssueStatus: () => null,
            readSessionMarks: () => MARKED
        }, { color: 'magenta' });
        expect(stripSgrCodes(result ?? '')).toBe(renderOsc8Link(`${SERVER}/browse/IM-3299`, 'IM-3299'));
        expect(result).toContain('\x1b[38;5;96m');
    });

    it('falls back to the default color when the item has no configured color', () => {
        const result = render({ cwd: '/tmp/repo' }, {
            getCachedJiraIssueStatus: () => null,
            readSessionMarks: () => MARKED
        });
        expect(result).toContain('\x1b[38;5;188m');
    });

    it('skips coloring entirely when colorByStatus is toggled off', () => {
        const status: JiraIssueStatus = { key: 'IM-3299', statusName: 'QA', statusCategoryKey: 'done' };
        const result = render({ cwd: '/tmp/repo' }, {
            getCachedJiraIssueStatus: () => status,
            readSessionMarks: () => MARKED
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
        const withIconResult = render({ cwd: '/tmp/repo' }, { readSessionMarks: () => MARKED }, { metadata: { icon: 'true' } });
        const withoutIconResult = render({ cwd: '/tmp/repo' }, { readSessionMarks: () => MARKED });

        expect(stripSgrCodes(withIconResult ?? '')).toBe(`\u{f802} ${renderOsc8Link(`${SERVER}/browse/IM-3299`, 'IM-3299')}`);
        expect(withoutIconResult).not.toContain('\u{f802}');
    });

    it('declares the no-issue hideable state', () => {
        expect(new JiraIssueWidget(createDeps()).getHideableStates().map(state => state.key)).toEqual(['no-issue']);
    });
});
