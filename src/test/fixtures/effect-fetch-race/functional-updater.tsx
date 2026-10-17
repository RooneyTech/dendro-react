import { useState, useEffect } from 'react';
export function Counter({ tick }: { tick: number }) {
  const [count, setCount] = useState(0);
  useEffect(() => { ping(tick).then(() => setCount(c => c + 1)); }, [tick]);
  return <div />;
}
