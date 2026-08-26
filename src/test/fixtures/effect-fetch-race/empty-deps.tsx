import { useState, useEffect } from 'react';
export function Once() {
  const [results, setResults] = useState(null);
  useEffect(() => { fetchResults().then(json => setResults(json)); }, []);
  return <div />;
}
