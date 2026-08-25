import React from 'react';
import { UserAvatar } from './UserAvatar';
import { LikeButton } from './LikeButton';

export const PostCard = ({ post }: { post: any }) => {
  return (
    <div>
      <UserAvatar user={post.author} />
      <p>{post.content}</p>
      <LikeButton postId={post.id} />
    </div>
  );
};
