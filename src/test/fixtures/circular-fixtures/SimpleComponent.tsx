import React from 'react';

// This component has no circular dependencies
const SimpleComponent: React.FC = () => {
  return (
    <div className="simple">
      <p>No circular deps here!</p>
    </div>
  );
};

export default SimpleComponent;
