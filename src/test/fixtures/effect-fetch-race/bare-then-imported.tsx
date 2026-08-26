import { useState, useEffect } from 'react';
import { track } from './analytics';
export function BareImported({ query }: { query: string }) {
  const [results, setResults] = useState(null);
  useEffect(() => { fetchResults(query).then(track); }, [query]);
  return <div />;
}
