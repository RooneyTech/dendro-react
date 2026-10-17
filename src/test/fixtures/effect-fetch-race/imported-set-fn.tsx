import { useState, useEffect } from 'react';
import { setLanguage } from './i18n';
export function Init({ lang }: { lang: string }) {
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => { await setLanguage(lang); setLoading(false); })();
  }, [lang]);
  return <div />;
}
