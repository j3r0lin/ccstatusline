import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function getLastPromptDir(): string {
    return path.join(os.homedir(), '.cache', 'ccstatusline', 'last-prompt');
}

function getLastPromptFilePath(sessionId: string): string {
    return path.join(getLastPromptDir(), sessionId);
}

export function saveLastPrompt(sessionId: string, prompt: string): void {
    const dir = getLastPromptDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getLastPromptFilePath(sessionId), prompt, 'utf-8');
}

export function readLastPrompt(sessionId: string): string | null {
    try {
        const content = fs.readFileSync(getLastPromptFilePath(sessionId), 'utf-8').trim();
        return content || null;
    } catch {
        return null;
    }
}
