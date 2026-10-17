import React, { createContext, useContext, useState, ReactNode } from 'react';

interface AuthContextValue {
  isVerified: boolean;
  userId: string | null;
  completeVerification: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [isVerified, setIsVerified] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const completeVerification = () => {
    setIsVerified(true);
    setUserId('user-123');
  };

  return (
    <AuthContext.Provider value={{ isVerified, userId, completeVerification }}>
      {children}
    </AuthContext.Provider>
  );
}
