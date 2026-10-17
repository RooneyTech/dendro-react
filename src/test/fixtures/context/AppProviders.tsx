import React, { ReactNode } from 'react';
import { AuthProvider } from './AuthContext';
import { TabBarProvider } from './TabBarContext';

interface AppProvidersProps {
  children: ReactNode;
}

export function AppProviders({ children }: AppProvidersProps) {
  return (
    <AuthProvider>
      <TabBarProvider>
        {children}
      </TabBarProvider>
    </AuthProvider>
  );
}
