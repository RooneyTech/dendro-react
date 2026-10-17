import React from 'react';

export const SecondaryButton = ({ children }: { children: React.ReactNode }) => {
  return (
    <button className="secondary">
      {children}
    </button>
  );
};
