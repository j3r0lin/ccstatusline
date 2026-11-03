import * as fs from 'node:fs';
import * as path from 'node:path';

import { discoverGitDir } from './git';

// Return null whenever Git must resolve the ref itself, including ambiguous names.
export function readCurrentBranch(cwd: string): string | null {
    try {
        if (process.env.GIT_DIR || process.env.GIT_COMMON_DIR || process.env.GIT_NAMESPACE
            || process.env.GIT_WORK_TREE || process.env.GIT_CEILING_DIRECTORIES || process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM)
            return null;
        const gitDir = discoverGitDir(fs.realpathSync(cwd));
        if (!gitDir)
            return null;
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const match = /^ref: refs\/heads\/(.+)$/.exec(head);
        if (!match?.[1])
            return null;
        const branch = match[1];
        let commonDir = gitDir;
        try {
            commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
        } catch { /* ordinary repository */ }
        const alternatives = [branch, `refs/${branch}`, `refs/tags/${branch}`, `refs/remotes/${branch}`, `refs/remotes/${branch}/HEAD`];
        if (alternatives.some(ref => fs.existsSync(path.join(commonDir, ref))))
            return null;
        try {
            const packed = fs.readFileSync(path.join(commonDir, 'packed-refs'), 'utf8');
            if (packed.split('\n').some(line => alternatives.some(ref => line.endsWith(` ${ref}`))))
                return null;
        } catch { /* no packed refs */ }
        const branchPath = path.join(commonDir, 'refs', 'heads', branch);
        if (fs.existsSync(branchPath) && fs.readFileSync(branchPath, 'utf8').startsWith('ref:'))
            return null;
        return branch;
    } catch {
        return null;
    }
}
