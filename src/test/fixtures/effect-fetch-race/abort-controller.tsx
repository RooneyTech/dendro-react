import { useState, useEffect } from 'react';
export function Aborted({ url }: { url: string }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal }).then(r => setData(r));
    return () => controller.abort();
  }, [url]);
  return <div />;
}
