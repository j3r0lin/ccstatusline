import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import { readLastPromptFromTranscript } from '../utils/last-prompt';

const DIM_ON = '\x1b[2m';
const DIM_OFF = '\x1b[22m';

export class LastPromptWidget implements Widget {
    getDefaultColor(): string { return ''; }
    getDescription(): string { return 'Shows the last user prompt submitted in this session'; }
    getDisplayName(): string { return 'Last Prompt'; }
    getCategory(): string { return 'Session'; }

    getEditorDisplay(_item: WidgetItem): WidgetEditorDisplay {
        return { displayText: this.getDisplayName() };
    }

    handleEditorAction(_action: string, _item: WidgetItem): WidgetItem | null {
        return null;
    }

    render(_item: WidgetItem, context: RenderContext, _settings: Settings): string | null {
        if (context.isPreview) {
            return `${DIM_ON}❯ What does this function do?${DIM_OFF}`;
        }

        const transcriptPath = context.data?.transcript_path;
        if (!transcriptPath)
            return null;

        const prompt = readLastPromptFromTranscript(transcriptPath);
        if (!prompt)
            return null;

        // Collapse newlines to a single line
        const oneLine = prompt.replace(/\r?\n/g, ' ').trim();
        return `${DIM_ON}❯ ${oneLine}${DIM_OFF}`;
    }

    supportsRawValue(): boolean { return false; }
    supportsColors(_item: WidgetItem): boolean { return false; }
}
