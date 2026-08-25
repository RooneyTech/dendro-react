import React from 'react';
import { PrimaryButton, SecondaryButton } from './src/components';

const NestedBarrelApp = () => {
  return (
    <div>
      <PrimaryButton>Click me</PrimaryButton>
      <SecondaryButton>Cancel</SecondaryButton>
    </div>
  );
};

export default NestedBarrelApp;
