import React from 'react';
import { avatarOf } from './persona.js';

// One letter on a solid colour, as a video call shows someone with no photo.
export default function Avatar({ person, className = 'h-16 w-16 text-xl', children }) {
  const { letter, color } = avatarOf(person);
  return <div data-avatar="true" className={`relative grid shrink-0 place-items-center rounded-full font-medium text-white ${className}`} style={{ backgroundColor: color }} aria-hidden="true">{letter}{children}</div>;
}
