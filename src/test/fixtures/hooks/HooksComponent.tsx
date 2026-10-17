import React, { useState, useEffect, useMemo, useCallback, useRef, useContext } from 'react';
import { ThemeContext } from './ThemeContext';

interface HooksComponentProps {
  initialCount: number;
  onCountChange?: (count: number) => void;
}

export function HooksComponent({ initialCount, onCountChange }: HooksComponentProps) {
  const [count, setCount] = useState(initialCount);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const theme = useContext(ThemeContext);

  // Effect with dependencies
  useEffect(() => {
    console.log('Count changed:', count);
    onCountChange?.(count);
  }, [count, onCountChange]);

  // Effect without dependencies (runs every render)
  useEffect(() => {
    console.log('Rendering...');
  });

  // Effect with empty dependencies (runs once)
  useEffect(() => {
    console.log('Mounted');
    return () => console.log('Unmounted');
  }, []);

  // Memoized value
  const doubledCount = useMemo(() => {
    return count * 2;
  }, [count]);

  // Memoized callback
  const handleClick = useCallback(() => {
    setCount(c => c + 1);
  }, []);

  return (
    <div style={{ background: theme.background }}>
      <input ref={inputRef} value={name} onChange={e => setName(e.target.value)} />
      <p>Count: {count}, Doubled: {doubledCount}</p>
      <button onClick={handleClick}>Increment</button>
    </div>
  );
}
