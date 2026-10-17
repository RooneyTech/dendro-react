// Low complexity component - minimal props, no state, simple JSX
import React from 'react';

interface Props {
  label: string;
  onClick: () => void;
}

export const SimpleButton: React.FC<Props> = ({ label, onClick }) => {
  return (
    <button onClick={onClick}>
      {label}
    </button>
  );
};
