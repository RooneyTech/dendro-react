import { useState, useEffect } from 'react';
export function Items({ page }: { page: number }) {
  const [items, setItems] = useState([]);
  useEffect(() => { getPage(page).then(({ items }) => setItems(items)); }, [page]);
  return <div />;
}
