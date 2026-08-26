import React from 'react';
import { GrandChild } from './GrandChild';

interface ChildProps {
  personId: string;
  displayName: string;
}

export function Child({ personId, displayName }: ChildProps) {
  return (
    <div>
      <span>ID: {personId}</span>
      <GrandChild id={personId} name={displayName} />
    </div>
  );
}
