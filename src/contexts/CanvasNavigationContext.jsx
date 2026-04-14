import { createContext } from 'react';

/**
 * Context for canvas navigation (nested canvas dive-in / dive-out).
 * Provided by Canvas.jsx, consumed by CanvasNode and BreadcrumbBar.
 */
export const CanvasNavigationContext = createContext(null);
