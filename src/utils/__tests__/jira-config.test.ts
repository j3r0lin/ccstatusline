import {
    describe,
    expect,
    it
} from 'vitest';

import {
    parseJiraCliConfig,
    readJiraCliConfig,
    type JiraConfigDeps
} from '../jira-config';

describe('parseJiraCliConfig', () => {
    it('reads the server field', () => {
        const content = [
            'auth_type: bearer',
            'project:',
            '    key: IM',
            '    type: ""',
            'server: https://jira.inhand.design',
            'timezone: Asia/Shanghai'
        ].join('\n');

        expect(parseJiraCliConfig(content)).toEqual({ server: 'https://jira.inhand.design' });
    });

    it('strips surrounding quotes from the value', () => {
        expect(parseJiraCliConfig('server: "https://jira.example.com"')).toEqual({ server: 'https://jira.example.com' });
    });

    it('returns an empty object when the field is missing', () => {
        expect(parseJiraCliConfig('installation: Local\n')).toEqual({ server: undefined });
    });
});

describe('readJiraCliConfig', () => {
    function createDeps(overrides: Partial<JiraConfigDeps> = {}): JiraConfigDeps {
        return {
            existsSync: () => false,
            readFileSync: (_path => '') as JiraConfigDeps['readFileSync'],
            getHomedir: () => '/home/user',
            ...overrides
        };
    }

    it('returns an empty object when the config file does not exist', () => {
        expect(readJiraCliConfig(createDeps())).toEqual({});
    });

    it('returns an empty object when reading the config file throws', () => {
        const deps = createDeps({
            existsSync: () => true,
            readFileSync: () => { throw new Error('EACCES'); }
        });
        expect(readJiraCliConfig(deps)).toEqual({});
    });

    it('parses the config found at ~/.config/.jira/.config.yml', () => {
        const deps = createDeps({
            existsSync: filePath => String(filePath) === '/home/user/.config/.jira/.config.yml',
            readFileSync: (_path => 'server: https://jira.example.com\n') as JiraConfigDeps['readFileSync']
        });
        expect(readJiraCliConfig(deps)).toEqual({ server: 'https://jira.example.com' });
    });
});
