import { createContext } from 'react';

export interface Theme {
  background: string;
  foreground: string;
}

export const ThemeContext = createContext<Theme>({
  background: '#ffffff',
  foreground: '#000000',
});
