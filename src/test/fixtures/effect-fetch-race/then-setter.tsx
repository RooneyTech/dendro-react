import { useState, useEffect } from 'react';
export function Search({ query }: { query: string }) {
  const [results, setResults] = useState(null);
  useEffect(() => { fetchResults(query).then(json => setResults(json)); }, [query]);
  return <div>{String(results)}</div>;
}
