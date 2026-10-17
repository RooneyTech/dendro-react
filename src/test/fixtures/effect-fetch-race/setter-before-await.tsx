import { useState, useEffect } from 'react';
export function BeforeAwait({ id }: { id: string }) {
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    (async () => { setLoading(true); const d = await load(id); return d; })();
  }, [id]);
  return <div />;
}
