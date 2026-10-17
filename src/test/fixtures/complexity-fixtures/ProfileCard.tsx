// Medium complexity - some state, one effect, moderate props
import React, { useState, useEffect } from 'react';

interface User {
  id: string;
  name: string;
  email: string;
  avatar: string;
}

interface Props {
  userId: string;
  showEmail: boolean;
  onEdit: (user: User) => void;
  onDelete: (userId: string) => void;
}

export const ProfileCard: React.FC<Props> = ({ userId, showEmail, onEdit, onDelete }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchUser = async () => {
      try {
        setIsLoading(true);
        const response = await fetch(`/api/users/${userId}`);
        const data = await response.json();
        setUser(data);
      } catch (err) {
        setError('Failed to load user');
      } finally {
        setIsLoading(false);
      }
    };
    fetchUser();
  }, [userId]);

  if (isLoading) {
    return (
      <div className="profile-card loading">
        <span>Loading...</span>
      </div>
    );
  }

  if (error || !user) {
    return (
      <div className="profile-card error">
        <span>{error || 'User not found'}</span>
      </div>
    );
  }

  return (
    <div className="profile-card">
      <div className="avatar">
        <img src={user.avatar} alt={user.name} />
      </div>
      <div className="info">
        <h2>{user.name}</h2>
        {showEmail && <p>{user.email}</p>}
      </div>
      <div className="actions">
        <button onClick={() => onEdit(user)}>Edit</button>
        <button onClick={() => onDelete(userId)}>Delete</button>
      </div>
    </div>
  );
};
