import React from 'react';
import { convertSelectionType } from './utils';

interface SelectionSettings {
  type: string;
  value: number;
}

interface SelectionCardProps {
  settings: SelectionSettings;
}

const SelectionCard: React.FC<SelectionCardProps> = ({ settings }) => {
  const convertedType = convertSelectionType(settings.type);

  return (
    <div className="selection-card">
      <span>{convertedType}</span>
      <span>{settings.value}</span>
    </div>
  );
};

export default SelectionCard;
export type { SelectionSettings };
