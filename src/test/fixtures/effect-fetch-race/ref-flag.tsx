import { useState, useEffect, useRef } from 'react';
export function RefGuard({ query }: { query: string }) {
  const [results, setResults] = useState(null);
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    fetchResults(query).then(json => { if (activeRef.current) setResults(json); });
    return () => { activeRef.current = false; };
  }, [query]);
  return <div />;
}
