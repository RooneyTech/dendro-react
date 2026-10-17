import * as React from 'react';
export function Screen({ navigation }: any) {
  React.useEffect(() => {
    return navigation?.addListener?.('tabPress', () => {});
  }, [navigation]);
  return null;
}
