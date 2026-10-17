// Very low complexity - single prop, no logic
import React from 'react';

interface Props {
  text: string;
}

export const Badge = ({ text }: Props) => <span className="badge">{text}</span>;
