/**
 * Centralized logging utility for the main process.
 * Suppresses info/debug logs in production to prevent spam.
 * Errors and warnings are always logged.
 */
import electronPkg from 'electron';
const { app } = electronPkg;

const isProd = app?.isPackaged;

export const logger = {
  info: (...args) => {
    if (!isProd) {
      console.log(...args);
    }
  },
  debug: (...args) => {
    if (!isProd) {
      console.debug(...args);
    }
  },
  warn: (...args) => {
    console.warn(...args);
  },
  error: (...args) => {
    console.error(...args);
  }
};

export default logger;
