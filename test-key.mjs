import { fetchPageHtml } from './electron/ipc/gemini.js';
import fs from 'fs';

const file = fs.readFileSync('./electron/ipc/gemini.js', 'utf8');
console.log("Key logic in file:", file.split('\n')[5]);
console.log("Current env:", process.env.VITE_GEMINI_API_KEY);
