import React, { useState } from 'react';
import { HomeScreen } from './HomeScreen';

export const RootNavigator = () => {
  const [currentScreen, setCurrentScreen] = useState('home');

  return (
    <div>
      <HomeScreen />
    </div>
  );
};
