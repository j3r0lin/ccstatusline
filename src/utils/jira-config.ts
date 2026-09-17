import {
    existsSync,
    readFileSync
} from 'fs';
import os from 'node:os';
import path from 'node:path';

// jira-cli (github.com/ankitpokhrel/jira-cli) keeps its config at
// ~/.config/.jira/.config.yml. It's YAML, but the repo has no YAML parser
// dependency and the one field the Jira Issue widget needs from it (server)
// sits at a predictable, shallow position, so a regex reads it without
// adding one.
export interface JiraCliConfig { server?: string }

export interface JiraConfigDeps {
    existsSync: typeof existsSync;
    readFileSync: typeof readFileSync;
    getHomedir: typeof os.homedir;
}

const DEFAULT_JIRA_CONFIG_DEPS: JiraConfigDeps = {
    existsSync,
    readFileSync,
    getHomedir: os.homedir
};

function getJiraCliConfigPath(deps: JiraConfigDeps): string {
    return path.join(deps.getHomedir(), '.config', '.jira', '.config.yml');
}

function stripQuotes(value: string): string {
    const trimmed = value.trim();
    const match = /^(['"])(.*)\1$/.exec(trimmed);
    return match?.[2] ?? trimmed;
}

// Reads `server: <url>` at the top level. Only the first match is used.
export function parseJiraCliConfig(content: string): JiraCliConfig {
    const serverMatch = /^server:\s*(.+)$/m.exec(content);
    const server = serverMatch?.[1] !== undefined ? stripQuotes(serverMatch[1]) : undefined;

    return { server: server && server.length > 0 ? server : undefined };
}

export function readJiraCliConfig(deps: JiraConfigDeps = DEFAULT_JIRA_CONFIG_DEPS): JiraCliConfig {
    try {
        const configPath = getJiraCliConfigPath(deps);
        if (!deps.existsSync(configPath)) {
            return {};
        }
        return parseJiraCliConfig(deps.readFileSync(configPath, 'utf-8'));
    } catch {
        return {};
    }
}
