import { useState, useEffect } from 'react';
export function Auth() {
  const [csrfToken, setCsrfToken] = useState<string | undefined>(undefined);
  // Self-limiting: the guard tests the very state the continuation sets, so
  // the effect stops firing once it lands. Converges; cannot corrupt.
  useEffect(() => {
    if (csrfToken === undefined)
      authService.requestCSRFToken().then((d: any) => d?.csrf_token && setCsrfToken(d.csrf_token));
  }, [csrfToken]);
  return <div>{csrfToken}</div>;
}
