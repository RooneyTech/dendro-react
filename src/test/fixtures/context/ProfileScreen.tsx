import React from 'react';
import { View, Text, Button } from 'react-native';
import { useAuth } from './AuthContext';

export function ProfileScreen() {
  const { isVerified, userId, completeVerification } = useAuth();

  return (
    <View>
      <Text>Profile</Text>
      <Text>User ID: {userId || 'Not logged in'}</Text>
      <Text>Verified: {isVerified ? 'Yes' : 'No'}</Text>
      {!isVerified && (
        <Button title="Verify Account" onPress={completeVerification} />
      )}
    </View>
  );
}
