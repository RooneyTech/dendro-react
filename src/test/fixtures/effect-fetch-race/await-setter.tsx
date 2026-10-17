import { useState, useEffect } from 'react';
export function Convert({ text }: { text: string }) {
  const [error, setError] = useState(null);
  useEffect(() => {
    const run = async () => { const result = await convert(text); setError(result.error); };
    run();
  }, [text]);
  return <div />;
}
