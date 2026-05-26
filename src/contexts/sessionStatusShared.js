import { createContext } from 'react';

export const SessionStatusContext = createContext({ statuses: {}, verifying: new Set() });
