import * as React from 'react';
export function Screen({ navigation }: any) {
  // Concise arrow body: the addListener return value IS the cleanup.
  React.useEffect(
    () => navigation.addListener('beforeRemove', (e: any) => { e.preventDefault(); }),
    [navigation]
  );
  return null;
}
