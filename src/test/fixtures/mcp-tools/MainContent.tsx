import React, { useState, useEffect } from 'react';
import UserProfile from './UserProfile';

const MainContent = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(false);
  }, []);

  return (
    <main>
      <UserProfile />
      {loading ? 'Loading...' : 'Content'}
    </main>
  );
};

export default MainContent;
