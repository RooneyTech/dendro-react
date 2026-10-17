import { useState, useEffect } from 'react';
export function NoDeps({ query }: { query: string }) {
  const [results, setResults] = useState(null);
  useEffect(() => { fetchResults(query).then(json => setResults(json)); });
  return <div />;
}
