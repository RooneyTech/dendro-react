import * as React from 'react';
export function Ticker({ delay }: { delay: number }) {
  // MUST still fire: setInterval returns an id, not a cleanup function.
  React.useEffect(() => setInterval(() => console.log('tick'), delay), [delay]);
  return null;
}
