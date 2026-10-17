"use client";

import React, { useState } from 'react';
import Navigation from './Navigation';

const Header = () => {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header>
      <Navigation />
      <button onClick={() => setMenuOpen(!menuOpen)}>Menu</button>
    </header>
  );
};

export default Header;
