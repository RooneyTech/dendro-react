import React from 'react';
import { PostCard } from '../components/PostCard';
import { Header } from '../components/Header';

export const FeedScreen = () => {
  const posts = [{ id: '1', content: 'Hello', author: { name: 'John' } }];

  return (
    <div>
      <Header title="Feed" />
      {posts.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}
    </div>
  );
};
