import React, { useState, useCallback, useMemo, useRef } from 'react';

interface Item {
  id: number;
  name: string;
}

export function ProperlyMemoizedComponent() {
  const [items, setItems] = useState<Item[]>([]);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Wrapped in useCallback — should NOT be flagged
  const handleClick = useCallback(() => {
    console.log('clicked');
  }, []);

  // Wrapped in useMemo — should NOT be flagged
  const filtered = useMemo(() => items.filter(i => i.name.includes(search)), [items, search]);

  // Wrapped in useCallback — should NOT be flagged
  const handleSubmit = useCallback(() => {
    setItems([]);
  }, []);

  return (
    <div>
      {/* All safe — zero risks expected */}
      <Button onClick={handleClick} />
      <List items={filtered} />
      <Form onSubmit={handleSubmit} />

      {/* Safe: state setter */}
      <Counter onChange={setSearch} />

      {/* Safe: ref */}
      <Input ref={inputRef} />
    </div>
  );
}

function Button(props: any) {
  return <button onClick={props.onClick}>Click</button>;
}

function List(props: any) {
  return <ul>{props.items?.map((i: any) => <li key={i.id}>{i.name}</li>)}</ul>;
}

function Form(props: any) {
  return <form onSubmit={props.onSubmit}><input /></form>;
}

function Counter(props: any) {
  return <input onChange={e => props.onChange(e.target.value)} />;
}

function Input(props: any) {
  return <input ref={props.ref} />;
}
