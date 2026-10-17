import React from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Home } from './pages/Home';
import { About } from './pages/About';
import { Team } from './pages/Team';
import { Dashboard } from './pages/Dashboard';

const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  {
    path: '/about',
    element: <About />,
    children: [
      { index: true, element: <About /> },
      { path: 'team', element: <Team /> },
    ],
  },
  { path: '/dashboard', element: <Dashboard /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
