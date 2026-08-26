import { useState, useEffect } from 'react';
export function Bare({ query }: { query: string }) {
  const [results, setResults] = useState(null);
  useEffect(() => { fetchResults(query).then(setResults); }, [query]);
  return <div />;
}
