import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import { collectDevServerUrls } from '../utils/dev-servers';
import { renderOsc8Link } from '../utils/hyperlink';

export class DevServerWidget implements Widget {
    getDefaultColor(): string { return 'cyan'; }
    getDescription(): string { return 'Shows clickable URLs of live dev servers started in this session'; }
    getDisplayName(): string { return 'Dev Server'; }
    getCategory(): string { return 'Session'; }

    getEditorDisplay(_item: WidgetItem): WidgetEditorDisplay {
        return { displayText: this.getDisplayName() };
    }

    handleEditorAction(_action: string, _item: WidgetItem): WidgetItem | null {
        return null;
    }

    render(_item: WidgetItem, context: RenderContext, _settings: Settings): string | null {
        if (context.isPreview)
            return renderOsc8Link('http://localhost:8000/', 'http://localhost:8000/');

        const transcriptPath = context.data?.transcript_path;
        if (!transcriptPath)
            return null;

        const urls = collectDevServerUrls(transcriptPath);
        if (urls.length === 0)
            return null;

        // The full URL is the link text: a terminal that ignores OSC-8 can still
        // pick the address up with its own URL detection, and `:8000` cannot.
        return urls.map(url => renderOsc8Link(url, url)).join(' · ');
    }

    supportsRawValue(): boolean { return false; }
    supportsColors(_item: WidgetItem): boolean { return true; }
}
