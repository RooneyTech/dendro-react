import React from 'react';

interface GrandChildProps {
  id: string;
  name: string;
}

export function GrandChild({ id, name }: GrandChildProps) {
  return (
    <div>
      <p>Final: {id} - {name}</p>
    </div>
  );
}
