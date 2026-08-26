import React from 'react';

export const PrimaryButton = ({ children }: { children: React.ReactNode }) => {
  return (
    <button className="primary">
      {children}
    </button>
  );
};
