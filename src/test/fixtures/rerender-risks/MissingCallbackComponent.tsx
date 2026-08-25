import React, { useState } from 'react';

export function MissingCallbackComponent() {
  const [count, setCount] = useState(0);

  // Bare function — should be flagged as missing-useCallback
  function handleClick() {
    setCount(c => c + 1);
  }

  // Bare arrow function assigned to variable — should be flagged
  const handleDelete = () => {
    console.log('delete');
  };

  return (
    <div>
      {/* Missing useCallback — should be flagged */}
      <Button onClick={handleClick} />
      <Button onDelete={handleDelete} />

      {/* Safe: state setter — should NOT be flagged */}
      <Counter onChange={setCount} />

      {/* Safe: prop passthrough — should NOT be flagged */}
    </div>
  );
}

function Button(props: any) {
  return <button {...props}>Click</button>;
}

function Counter(props: any) {
  return <span>{props.count}</span>;
}
