import { useState, useEffect } from 'react';
export function Good({ query }: { query: string }) {
  const [results, setResults] = useState(null);
  useEffect(() => {
    let ignore = false;
    fetchResults(query).then(json => { if (!ignore) setResults(json); });
    return () => { ignore = true; };
  }, [query]);
  return <div />;
}
