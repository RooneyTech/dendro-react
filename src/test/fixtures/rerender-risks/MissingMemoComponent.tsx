import React, { useState } from 'react';

interface Item {
  id: number;
  name: string;
  active: boolean;
}

export function MissingMemoComponent() {
  const [items, setItems] = useState<Item[]>([]);
  const [search, setSearch] = useState('');

  // Bare .filter() — should be flagged as missing-useMemo
  const filtered = items.filter(i => i.name.includes(search));

  // Bare .map() — should be flagged as missing-useMemo
  const names = items.map(i => i.name);

  // Bare spread object — should be flagged as missing-useMemo
  const config = { ...items[0], extra: true };

  return (
    <div>
      {/* Missing useMemo — should be flagged */}
      <List items={filtered} />
      <Tags data={names} />
      <Detail config={config} />
    </div>
  );
}

function List(props: any) {
  return <ul>{props.items?.map((i: any) => <li key={i.id}>{i.name}</li>)}</ul>;
}

function Tags(props: any) {
  return <div>{props.data?.join(', ')}</div>;
}

function Detail(props: any) {
  return <pre>{JSON.stringify(props.config)}</pre>;
}
