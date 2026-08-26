import React from 'react';
import { View, Text, Switch } from 'react-native';
import { useAuth } from './AuthContext';
import { useTabBar } from './TabBarContext';

export function SettingsScreen() {
  const { isVerified, userId } = useAuth();
  const { hideTabBarBlur, setHideTabBarBlur } = useTabBar();

  return (
    <View>
      <Text>Settings</Text>
      <Text>User: {userId}</Text>
      <Text>Verified: {isVerified ? 'Yes' : 'No'}</Text>
      <View>
        <Text>Hide Tab Bar Blur</Text>
        <Switch
          value={hideTabBarBlur}
          onValueChange={setHideTabBarBlur}
        />
      </View>
    </View>
  );
}
