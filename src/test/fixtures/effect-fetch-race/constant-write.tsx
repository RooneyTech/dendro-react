import { useState, useEffect } from 'react';
export function ConstantWrite({ id }: { id: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => { (async () => { await load(id); setReady(true); })(); }, [id]);
  return <div />;
}
