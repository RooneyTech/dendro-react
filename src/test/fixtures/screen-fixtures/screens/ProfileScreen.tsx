import React from 'react';
import { ProfileCard } from '../components/ProfileCard';
import { Header } from '../components/Header';

export const ProfileScreen = () => {
  const user = { name: 'John', bio: 'Developer' };

  return (
    <div>
      <Header title="Profile" />
      <ProfileCard user={user} />
    </div>
  );
};
