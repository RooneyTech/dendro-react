import React, { createContext, useContext, useState, ReactNode } from 'react';

interface TabBarContextValue {
  hideTabBarBlur: boolean;
  setHideTabBarBlur: (hide: boolean) => void;
}

export const TabBarContext = createContext<TabBarContextValue>({
  hideTabBarBlur: false,
  setHideTabBarBlur: () => {},
});

export function useTabBar() {
  return useContext(TabBarContext);
}

interface TabBarProviderProps {
  children: ReactNode;
}

export function TabBarProvider({ children }: TabBarProviderProps) {
  const [hideTabBarBlur, setHideTabBarBlur] = useState(false);

  return (
    <TabBarContext.Provider value={{ hideTabBarBlur, setHideTabBarBlur }}>
      {children}
    </TabBarContext.Provider>
  );
}
