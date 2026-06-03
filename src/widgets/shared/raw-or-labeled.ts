import type { WidgetItem } from '../../types/Widget';

export function formatRawOrLabeledValue(item: WidgetItem, labelPrefix: string, value: string): string {
    if (item.rawValue) {
        const customPrefix = item.metadata?.prefix;
        return customPrefix ? `${customPrefix}${value}` : value;
    }
    return `${labelPrefix}${value}`;
}
