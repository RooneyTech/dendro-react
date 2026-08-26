import { useState, useEffect } from 'react';
export function Transitive({ id }: { id: string }) {
  const [error, setError] = useState(null);
  useEffect(() => {
    (async () => { const result = await load(id); const err = result.error; setError(err); })();
  }, [id]);
  return <div />;
}
