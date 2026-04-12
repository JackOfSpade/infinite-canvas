// Node types
import { DocumentNode } from '../nodes/DocumentNode';
import { TextNode } from '../nodes/TextNode';
import { CanvasNode } from '../nodes/CanvasNode';
import { LinkNode } from '../nodes/LinkNode';
import { ListingNode } from '../nodes/ListingNode';

export const nodeTypes = {
  document: DocumentNode,
  text: TextNode,
  group: CanvasNode, // Keep 'group' key for backward compatibility of saved nodes, but map it to CanvasNode
  link: LinkNode,
  listing: ListingNode,
};

export const DEFAULT_EDGE_OPTIONS = { type: 'smoothstep' };
export const EDGE_STYLE = { stroke: '#a855f7', strokeWidth: 2 };
