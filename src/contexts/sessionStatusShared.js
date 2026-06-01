import { createContext } from 'react';

export const SessionStatusContext = createContext({ verifying: new Set() });
