// Low complexity - few props, simple JSX
import React from 'react';

interface Props {
  label: string;
  value: string;
  icon?: string;
  onPress: () => void;
}

export const OptionRow = ({ label, value, icon, onPress }: Props) => {
  return (
    <div className="option-row" onClick={onPress}>
      {icon && <span className="icon">{icon}</span>}
      <span className="label">{label}</span>
      <span className="value">{value}</span>
    </div>
  );
};
