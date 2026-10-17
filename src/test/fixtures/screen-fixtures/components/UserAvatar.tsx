import React from 'react';

export const UserAvatar = ({ user }: { user: any }) => {
  return <img src={user.avatarUrl} alt={user.name} />;
};
