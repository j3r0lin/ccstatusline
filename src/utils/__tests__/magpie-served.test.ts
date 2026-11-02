import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import {
    DEFAULT_MAGPIE_SERVED_DEPS,
    MAGPIE_SERVED_REFRESH_FLAG,
    mergeServed,
    parseServedCsv,
    readServedCache,
    refreshServedCacheFromCli,
    requestServedRefresh,
    servedRefreshWindow,
    type MagpieServedDeps,
    type ServedCache
} from '../magpie-served';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = Date.parse('2026-11-02T08:00:00Z');

function cache(overrides: Partial<ServedCache> = {}): ServedCache {
    return { version: 1, ids: {}, coveredFrom: NOW - DAY, fetchedAt: NOW - 10 * MINUTE, attemptedAt: NOW - 10 * MINUTE, ...overrides };
}

describe('parsing magpie usage CSV', () => {
    it('reads response id, served model and time by column name', () => {
        const csv = [
            'time,requested_model,served_model,response_id',
            '2026-11-02T15:16:34+08:00,auto-sonnet,claude-sonnet-5-5,msg_1',
            '2026-11-02T15:16:31+08:00,auto-sonnet,glm-5.3,msg_2'
        ].join('\n');

        expect(parseServedCsv(csv, 0)).toEqual([
            { id: 'msg_1', model: 'claude-sonnet-5-5', at: Date.parse('2026-11-02T07:16:34Z') },
            { id: 'msg_2', model: 'glm-5.3', at: Date.parse('2026-11-02T07:16:31Z') }
        ]);
    });

    it('keeps the columns aligned across quoted fields with commas, quotes and newlines', () => {
        const csv = [
            'time,error_message,served_model,response_id',
            '2026-11-02T15:00:00+08:00,"overloaded, retry ""later""\nsecond line",kimi-k3,msg_1',
            '2026-11-02T15:01:00+08:00,,glm-5.3,msg_2'
        ].join('\r\n');

        expect(parseServedCsv(csv, 0).map(row => [row.id, row.model])).toEqual([['msg_1', 'kimi-k3'], ['msg_2', 'glm-5.3']]);
    });

    it('skips rows without a served model or a response id', () => {
        const csv = ['time,served_model,response_id', 't,,msg_1', 't,glm-5.3,', 't,glm-5.3,msg_3'].join('\n');

        expect(parseServedCsv(csv, 5)).toEqual([{ id: 'msg_3', model: 'glm-5.3', at: 5 }]);
    });

    it('returns nothing for output that is not the expected CSV', () => {
        expect(parseServedCsv('', 0)).toEqual([]);
        expect(parseServedCsv('error: no such flag', 0)).toEqual([]);
    });
});

describe('merging fetched rows into the cache', () => {
    it('adds rows and drops entries logged more than 7 days ago', () => {
        const previous = cache({ ids: { old: { model: 'a', at: NOW - 8 * DAY }, kept: { model: 'b', at: NOW - DAY } } });

        const merged = mergeServed(previous, [{ id: 'new', model: 'c', at: NOW - MINUTE }, { id: 'stale', model: 'd', at: NOW - 9 * DAY }], NOW, 30 * MINUTE, NOW);

        expect(Object.keys(merged.ids).sort()).toEqual(['kept', 'new']);
    });

    it('widens the covered range when the new fetch reaches back to the old one', () => {
        const merged = mergeServed(cache(), [], NOW, 2 * DAY, NOW);

        expect(merged).toMatchObject({ fetchedAt: NOW, coveredFrom: NOW - 2 * DAY });
        expect(mergeServed(cache(), [], NOW, MINUTE * 30, NOW).coveredFrom).toBe(NOW - DAY);
    });

    it('replaces the range instead of claiming a gap nobody fetched', () => {
        const previous = cache({ coveredFrom: NOW - 6 * DAY, fetchedAt: NOW - 5 * DAY });

        expect(mergeServed(previous, [], NOW, 30 * MINUTE, NOW).coveredFrom).toBe(NOW - 30 * MINUTE);
    });

    it('never claims coverage older than 7 days', () => {
        expect(mergeServed(null, [], NOW, 20 * DAY, NOW).coveredFrom).toBe(NOW - 7 * DAY);
    });
});

describe('when a refresh is due', () => {
    it('is due when a step is older than the covered range', () => {
        expect(servedRefreshWindow(cache(), [NOW - 2 * DAY], NOW)).toBe(2 * DAY + 5 * MINUTE);
    });

    it('is due when a step is newer than the last fetch', () => {
        expect(servedRefreshWindow(cache(), [NOW - MINUTE], NOW)).toBe(6 * MINUTE);
    });

    it('is due when nothing was ever fetched', () => {
        expect(servedRefreshWindow(null, [NOW - 10 * MINUTE], NOW)).toBe(15 * MINUTE);
    });

    it('is not due for a step inside the covered range, which magpie never saw', () => {
        expect(servedRefreshWindow(cache(), [NOW - 3 * 60 * MINUTE], NOW)).toBeNull();
    });

    it('is not due within 30 seconds of the last fetch or attempt', () => {
        expect(servedRefreshWindow(cache({ fetchedAt: NOW - 20_000 }), [NOW - 10_000], NOW)).toBeNull();
        expect(servedRefreshWindow(cache({ attemptedAt: NOW - 20_000 }), [NOW - 2 * DAY], NOW)).toBeNull();
    });

    it('reaches back to the earliest step that is due and never beyond 7 days', () => {
        expect(servedRefreshWindow(cache(), [NOW - 2 * DAY, NOW - MINUTE], NOW)).toBe(2 * DAY + 5 * MINUTE);
        expect(servedRefreshWindow(cache({ coveredFrom: NOW - 7 * DAY }), [NOW - 7 * DAY + MINUTE - 1], NOW)).toBeNull();
        expect(servedRefreshWindow(null, [NOW - 7 * DAY + MINUTE], NOW)).toBe(7 * DAY);
    });

    it('ignores a step older than the 7 days the cache keeps', () => {
        expect(servedRefreshWindow(null, [NOW - 8 * DAY], NOW)).toBeNull();
    });
});

describe('refreshing from the magpie CLI', () => {
    let home: string;
    let spawned: string[][];
    let execArgs: string[][];
    let csv: string | Error;
    let now: number;

    function makeDeps(): MagpieServedDeps {
        return {
            ...DEFAULT_MAGPIE_SERVED_DEPS,
            getHomedir: () => home,
            getScriptPath: () => '/app/ccstatusline.js',
            getExecPath: () => '/usr/bin/node',
            now: () => now,
            spawn: ((command: string, args: string[]) => {
                spawned.push([command, ...args]);
                return { unref: () => undefined };
            }) as unknown as MagpieServedDeps['spawn'],
            execFileSync: ((_command: string, args: string[]) => {
                execArgs.push(args);
                if (csv instanceof Error) {
                    throw csv;
                }
                return csv;
            }) as unknown as MagpieServedDeps['execFileSync']
        };
    }

    const lockPath = () => path.join(home, '.cache', 'ccstatusline', 'magpie-served.json.lock');

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-magpie-served-'));
        spawned = [];
        execArgs = [];
        csv = '';
        now = NOW;
    });

    afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('spawns one detached refresh with the window and lock, and none while the lock is held', () => {
        const deps = makeDeps();

        requestServedRefresh(null, [NOW - 10 * MINUTE], deps);
        // The injected clock is not the file system's, so stamp the lock with it
        fs.utimesSync(lockPath(), new Date(NOW), new Date(NOW));
        requestServedRefresh(null, [NOW - 10 * MINUTE], deps);

        expect(spawned).toEqual([['/usr/bin/node', '/app/ccstatusline.js', MAGPIE_SERVED_REFRESH_FLAG, String(15 * MINUTE), lockPath()]]);
    });

    it('spawns nothing when no step is due', () => {
        requestServedRefresh(cache(), [NOW - 3 * 60 * MINUTE], makeDeps());

        expect(spawned).toEqual([]);
    });

    it('takes over a lock left by a refresh that died', () => {
        const deps = makeDeps();
        fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
        fs.writeFileSync(lockPath(), '');
        now = NOW + 10 * MINUTE;
        fs.utimesSync(lockPath(), new Date(NOW), new Date(NOW));

        requestServedRefresh(null, [now - MINUTE], deps);

        expect(spawned).toHaveLength(1);
    });

    it('fetches the window, stores the served models, and releases the lock', () => {
        csv = 'time,served_model,response_id\n2026-11-02T07:59:00Z,claude-sonnet-5-5,msg_1\n';
        fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
        fs.writeFileSync(lockPath(), '');

        refreshServedCacheFromCli(90 * MINUTE, lockPath(), makeDeps());

        expect(execArgs).toEqual([['usage', '--csv', '--last', '90m']]);
        expect(readServedCache(makeDeps())).toMatchObject({
            ids: { msg_1: { model: 'claude-sonnet-5-5' } },
            fetchedAt: NOW,
            coveredFrom: NOW - 90 * MINUTE
        });
        expect(fs.existsSync(lockPath())).toBe(false);
    });

    it('keeps earlier entries and records the attempt when magpie fails', () => {
        const deps = makeDeps();
        csv = 'time,served_model,response_id\n2026-11-02T07:59:00Z,glm-5.3,msg_1\n';
        refreshServedCacheFromCli(30 * MINUTE, lockPath(), deps);

        now = NOW + 5 * MINUTE;
        csv = new Error('magpie: command not found');
        refreshServedCacheFromCli(30 * MINUTE, lockPath(), deps);

        expect(readServedCache(deps)).toMatchObject({ ids: { msg_1: { model: 'glm-5.3' } }, fetchedAt: NOW, attemptedAt: now });
        // The failed attempt holds off the next one
        requestServedRefresh(readServedCache(deps), [now + 10_000], { ...deps, now: () => now + 20_000 });
        expect(spawned).toEqual([]);
    });

    it('does not delete a file other than its own lock', () => {
        const other = path.join(home, 'keep.txt');
        fs.writeFileSync(other, 'x');

        refreshServedCacheFromCli(MINUTE, other, makeDeps());

        expect(fs.existsSync(other)).toBe(true);
    });
});
