import React from 'react';

interface Props {
  name: string;
  count: number;
}

export function InlinePropsComponent({ name, count }: Props) {
  return (
    <div>
      {/* Inline object — should be flagged */}
      <Child style={{ color: 'red', fontSize: 14 }} />

      {/* Inline array — should be flagged */}
      <Child data={[1, 2, 3]} />

      {/* Inline arrow function — should be flagged */}
      <Child onClick={() => console.log('clicked')} />

      {/* Inline function expression — should be flagged */}
      <Child onSubmit={function() { return true; }} />

      {/* Safe: primitives — should NOT be flagged */}
      <Child label="hello" />
      <Child count={5} />
      <Child disabled={true} />
      <Child name={name} />
      <Child count={count} />
    </div>
  );
}

function Child(props: any) {
  return <span>{JSON.stringify(props)}</span>;
}
