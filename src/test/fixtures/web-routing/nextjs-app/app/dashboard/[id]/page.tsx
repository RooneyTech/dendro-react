import React from 'react';

export default function DashboardDetailPage({ params }: { params: { id: string } }) {
  return <h1>Dashboard {params.id}</h1>;
}
