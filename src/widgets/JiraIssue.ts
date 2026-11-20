import { getColorLevelString } from '../types/ColorLevel';
import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    CustomKeybind,
    HideableState,
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import { getColorAnsiCode } from '../utils/colors';
import { renderOsc8Link } from '../utils/hyperlink';
import { readJiraCliConfig } from '../utils/jira-config';
import type { JiraIssueStatus } from '../utils/jira-issue-cache';
import { getCachedJiraIssueStatus } from '../utils/jira-issue-cache';
import { readSessionMarks } from '../utils/session-marks';

import { isHidden } from './shared/hideable';
import { removeMetadataKeys } from './shared/metadata';

const NO_ISSUE_HIDEABLE_STATE: HideableState = { key: 'no-issue', label: 'when no issue is resolved' };
const COLOR_BY_STATUS_METADATA_KEY = 'colorByStatus';
const TOGGLE_COLOR_ACTION = 'toggle-color-by-status';

// Built-in status.name -> color map. Checked before the statusCategory
// fallback below, and can be overridden per status name via
// settings.jira.statusColors.
const DEFAULT_STATUS_COLOR_MAP: Record<string, string> = {
    'Backlog': 'brightBlack',
    'Planned': 'brightBlue',
    'Blocked': 'brightRed',
    'In Progress': 'brightYellow',
    'QA': 'brightCyan',
    'Done': 'brightGreen'
};

// Fallback used only when the status name has no entry above. Jira instances
// are free to reassign a status's category (e.g. this project's "QA" reports
// category "done" and "Blocked" reports "new"), which is exactly why the
// name-based map takes priority over this table.
const STATUS_CATEGORY_COLOR_MAP: Record<string, string> = {
    new: 'brightBlack',
    indeterminate: 'brightYellow',
    done: 'brightGreen'
};

// Nerd Font's Jira glyph (nf-custom-jira). Falls back to a blank box in a
// terminal without a patched font, so it is a separate metadata toggle.
const JIRA_ICON = '\u{f802}';
const ICON_METADATA_KEY = 'icon';
const TOGGLE_ICON_ACTION = 'toggle-jira-icon';

function isColorByStatusEnabled(item: WidgetItem): boolean {
    return item.metadata?.[COLOR_BY_STATUS_METADATA_KEY] !== 'false';
}

function isIconEnabled(item: WidgetItem): boolean {
    return item.metadata?.[ICON_METADATA_KEY] === 'true';
}

function toggleIcon(item: WidgetItem): WidgetItem {
    if (isIconEnabled(item)) {
        return removeMetadataKeys(item, [ICON_METADATA_KEY]);
    }
    return { ...item, metadata: { ...item.metadata, [ICON_METADATA_KEY]: 'true' } };
}

function withIcon(item: WidgetItem, text: string): string {
    return isIconEnabled(item) ? `${JIRA_ICON} ${text}` : text;
}

function toggleColorByStatus(item: WidgetItem): WidgetItem {
    if (isColorByStatusEnabled(item)) {
        return {
            ...item,
            metadata: { ...item.metadata, [COLOR_BY_STATUS_METADATA_KEY]: 'false' }
        };
    }
    return removeMetadataKeys(item, [COLOR_BY_STATUS_METADATA_KEY]);
}

function resolveStatusColor(status: JiraIssueStatus, overrides: Record<string, string> | undefined): string | null {
    return overrides?.[status.statusName]
        ?? DEFAULT_STATUS_COLOR_MAP[status.statusName]
        ?? STATUS_CATEGORY_COLOR_MAP[status.statusCategoryKey]
        ?? null;
}

function buildIssueUrl(server: string, key: string): string {
    return `${server.replace(/\/+$/, '')}/browse/${key}`;
}

export interface JiraIssueWidgetDeps {
    getCachedJiraIssueStatus: typeof getCachedJiraIssueStatus;
    readJiraCliConfig: typeof readJiraCliConfig;
    readSessionMarks: typeof readSessionMarks;
}

const DEFAULT_JIRA_ISSUE_WIDGET_DEPS: JiraIssueWidgetDeps = {
    getCachedJiraIssueStatus,
    readJiraCliConfig,
    readSessionMarks
};

const PREVIEW_KEY = 'IM-3299';
const PREVIEW_STATUS: JiraIssueStatus = { key: PREVIEW_KEY, statusName: 'In Progress', statusCategoryKey: 'indeterminate' };
const PREVIEW_SERVER = 'https://example.atlassian.net';

export class JiraIssueWidget implements Widget {
    constructor(private readonly deps: JiraIssueWidgetDeps = DEFAULT_JIRA_ISSUE_WIDGET_DEPS) {}

    // White by default: this color only ever shows when the status is unknown
    // (cache miss, no jira CLI), so it must not collide with a status color -
    // grey is Backlog's.
    getDefaultColor(): string { return 'white'; }
    getDescription(): string { return 'Shows the Jira issue the session marked with `ccstatusline mark jira` (clickable link), colored by status'; }
    getDisplayName(): string { return 'Jira Issue'; }
    getCategory(): string { return 'Session'; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return {
            displayText: this.getDisplayName(),
            modifierText: isColorByStatusEnabled(item) ? undefined : '(no status color)'
        };
    }

    getHideableStates(): HideableState[] {
        return [NO_ISSUE_HIDEABLE_STATE];
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        if (action === TOGGLE_COLOR_ACTION) {
            return toggleColorByStatus(item);
        }
        if (action === TOGGLE_ICON_ACTION) {
            return toggleIcon(item);
        }
        return null;
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const colorByStatus = isColorByStatusEnabled(item);
        const colorLevel = getColorLevelString(settings.colorLevel);
        const colorize = (text: string, colorName: string | null): string => {
            if (settings.colorLevel === 0 || !colorName) {
                return text;
            }
            const code = getColorAnsiCode(colorName, colorLevel, false);
            return code ? `${code}${text}\x1b[39m` : text;
        };

        const jiraConfig = this.deps.readJiraCliConfig();
        const server = settings.jira?.server ?? jiraConfig.server;

        if (context.isPreview) {
            const previewServer = server ?? PREVIEW_SERVER;
            const linkText = withIcon(item, renderOsc8Link(buildIssueUrl(previewServer, PREVIEW_KEY), PREVIEW_KEY));
            return colorByStatus ? colorize(linkText, resolveStatusColor(PREVIEW_STATUS, settings.jira?.statusColors)) : linkText;
        }

        // With colorByStatus on, the renderer skips its own foreground for this
        // widget, so every path must emit a color of its own. Falling back to
        // the item's configured color keeps the text readable when the status
        // is unknown instead of leaving it on the terminal default, which a
        // Powerline background can swallow.
        const fallbackColor = colorByStatus ? item.color ?? this.getDefaultColor() : null;
        const showNoIssue = (): string | null => isHidden(item, NO_ISSUE_HIDEABLE_STATE.key)
            ? null
            : colorize(withIcon(item, '(no issue)'), fallbackColor);

        // Only the issue the session declared with `ccstatusline mark jira`:
        // guessing it from branch names or the transcript showed issues the
        // session merely touched.
        const key = this.deps.readSessionMarks(context.data?.transcript_path).jira?.key;
        if (!key) {
            return showNoIssue();
        }

        const linkText = withIcon(item, server
            ? renderOsc8Link(buildIssueUrl(server, key), key)
            : key);
        if (!colorByStatus) {
            return linkText;
        }

        const status = this.deps.getCachedJiraIssueStatus(key);
        if (!status) {
            return colorize(linkText, fallbackColor);
        }

        return colorize(linkText, resolveStatusColor(status, settings.jira?.statusColors) ?? fallbackColor);
    }

    getCustomKeybinds(): CustomKeybind[] {
        return [
            { key: 'c', label: '(c)olor by status', action: TOGGLE_COLOR_ACTION },
            { key: 'j', label: '(j)ira icon', action: TOGGLE_ICON_ACTION }
        ];
    }

    // The widget colors its own output by status when colorByStatus is on, so
    // the renderer must preserve those codes instead of applying the item's
    // configured foreground color on top of them.
    preservesRenderedColors(item: WidgetItem): boolean {
        return isColorByStatusEnabled(item);
    }

    supportsRawValue(): boolean { return false; }
    supportsColors(item: WidgetItem): boolean { return !isColorByStatusEnabled(item); }
}
