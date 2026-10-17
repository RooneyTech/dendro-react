import React from 'react';
import { Child } from './Child';

interface ParentProps {
  userId: string;
  userName: string;
}

export function Parent({ userId, userName }: ParentProps) {
  return (
    <div>
      <h1>User: {userName}</h1>
      <Child personId={userId} displayName={userName} />
    </div>
  );
}
