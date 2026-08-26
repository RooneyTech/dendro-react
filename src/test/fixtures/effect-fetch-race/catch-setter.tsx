import { useState, useEffect } from 'react';
export function Preview({ a, b }: { a: number; b: number }) {
  const [err, setErr] = useState(null);
  useEffect(() => {
    render(a, b).then(canvas => { setErr(null); mount(canvas); }).catch(e => setErr(e));
  }, [a, b]);
  return <div />;
}
