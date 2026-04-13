/**
 * Centralized factory functions for creating node data objects.
 * Eliminates duplicate inline node construction across hooks.
 */
import { v4 as uuidv4 } from 'uuid';

export function createTextNode(position) {
  return { id: uuidv4(), type: 'text', position, data: { text: '', isNew: true } };
}

export function createLinkNode(position) {
  return { id: uuidv4(), type: 'link', position, data: { url: '', label: '', isNew: true } };
}

export function createGroupNode(position) {
  return {
    id: uuidv4(), type: 'group', dragHandle: '.drag-handle',
    style: { width: 320 }, position,
    data: { title: '', nodes: [], edges: [], collapsed: false, isNew: true },
  };
}

export function createDocumentNode(id, position, filename, filePath) {
  return { id, type: 'document', position, data: { filename, filePath } };
}

export function createListingNode(position, platform, url, label) {
  return {
    id: uuidv4(), type: 'listing', position,
    data: { platform, url, label, monitoring: false, activityCount: 0, error: null },
  };
}
