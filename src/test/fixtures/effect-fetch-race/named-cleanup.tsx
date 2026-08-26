import { useState, useEffect } from 'react';
export function NamedCleanup({ query }: { query: string }) {
  const [results, setResults] = useState(null);
  useEffect(() => {
    let done = false;
    const cleanup = () => { done = true; };
    fetchResults(query).then(json => { if (!done) setResults(json); });
    return cleanup;
  }, [query]);
  return <div />;
}
