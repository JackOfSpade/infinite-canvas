import React from 'react';
import { renderToString } from 'react-dom/server';
import { FileCode } from 'lucide-react';
console.log(renderToString(<FileCode x={10} y={20} width={30} height={30} />));
