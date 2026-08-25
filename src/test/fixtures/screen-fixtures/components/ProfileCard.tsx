import React from 'react';
import { UserAvatar } from './UserAvatar';

export const ProfileCard = ({ user }: { user: any }) => {
  return (
    <div>
      <UserAvatar user={user} />
      <h2>{user.name}</h2>
      <p>{user.bio}</p>
    </div>
  );
};
