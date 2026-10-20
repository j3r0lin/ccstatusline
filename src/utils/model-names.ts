import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface NameRule {
    match: string;
    name: string;
    title?: boolean;
}

interface NameTable {
    names?: Record<string, string>;
    suffixes?: Record<string, string>;
    words?: Record<string, string>;
    rules?: NameRule[];
}

// Shared with the other plugin that shows model names, so both render the same text.
export function getModelNamesPath(): string {
    return path.join(os.homedir(), '.config', 'model-names.json');
}

function loadTable(file: string): NameTable {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8')) as NameTable;
    } catch {
        return {};
    }
}

function applyWordsAndRules(table: NameTable, bare: string): string {
    let name = bare;
    for (const [from, to] of Object.entries(table.words ?? {})) {
        name = name.split(from).join(to);
    }
    for (const rule of table.rules ?? []) {
        const re = new RegExp(rule.match);
        if (!re.test(name)) {
            continue;
        }
        const out = name.replace(re, rule.name).replace(/\.$/, '');
        return rule.title ? out.charAt(0).toUpperCase() + out.slice(1) : out;
    }
    return name;
}

/** Display name for a model id: strip provider, `[...]` and date, then look up the shared alias table. */
export function formatModelName(id: string, file: string = getModelNamesPath()): string {
    const table = loadTable(file);
    const bare = id.replace(/^.*\//, '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');

    const whole = table.names?.[bare];
    if (whole) {
        return whole;
    }

    for (const [suffix, label] of Object.entries(table.suffixes ?? {})) {
        if (!bare.endsWith(suffix)) {
            continue;
        }
        const rest = bare.slice(0, -suffix.length);
        const named = applyWordsAndRules(table, rest);
        return named === rest ? bare : named + label;
    }

    return applyWordsAndRules(table, bare);
}
