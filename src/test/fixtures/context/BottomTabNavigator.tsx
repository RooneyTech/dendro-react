import React, { useContext } from 'react';
import { View } from 'react-native';
import { TabBarContext } from './TabBarContext';

export function BottomTabNavigator() {
  const { hideTabBarBlur } = useContext(TabBarContext);

  return (
    <View style={{ opacity: hideTabBarBlur ? 0 : 1 }}>
      {/* Tab bar content */}
    </View>
  );
}
