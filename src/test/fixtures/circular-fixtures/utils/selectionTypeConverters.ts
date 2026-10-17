// This file creates a circular dependency by importing from SelectionCard
import type { SelectionSettings } from '../SelectionCard';

export function convertSelectionType(type: string): string {
  const typeMap: Record<string, string> = {
    'single': 'Single Selection',
    'multi': 'Multiple Selection',
    'range': 'Range Selection'
  };
  return typeMap[type] || type;
}

export function validateSelection(settings: SelectionSettings): boolean {
  return settings.type.length > 0 && settings.value >= 0;
}
