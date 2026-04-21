import { cloneNode, reassignCanvasDataIDs } from './src/utils/nodeFactory.js';
import crypto from 'crypto';
global.crypto = crypto; // Polyfill crypto for node

const node = {
  id: 'group1',
  type: 'group',
  position: { x: 0, y: 0 },
  selected: true,
  data: {
    canvasData: {
      nodes: [
        { id: '1', type: 'text', position: {x: 0, y: 0}, data: { text: "hello" } },
        { id: '2', type: 'document', position: {x:0, y:0}, data: { filename: "hi" } }
      ],
      edges: [],
      drawings: []
    }
  }
};

const clone = cloneNode(node, 20, 20);
const finalClone = reassignCanvasDataIDs(clone);
console.log(JSON.stringify(finalClone, null, 2));
