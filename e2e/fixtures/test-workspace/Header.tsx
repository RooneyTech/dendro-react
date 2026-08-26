import React, { useState } from 'react';

const Header = () => {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header>
      <h1>Dendro Test App</h1>
      <button onClick={() => setMenuOpen(!menuOpen)}>Menu</button>
    </header>
  );
};

export default Header;
