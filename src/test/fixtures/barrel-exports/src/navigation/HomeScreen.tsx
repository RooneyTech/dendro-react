import React, { useState } from 'react';

export const HomeScreen = () => {
  const [title, setTitle] = useState('Home');

  return (
    <div>
      <h1>{title}</h1>
    </div>
  );
};
