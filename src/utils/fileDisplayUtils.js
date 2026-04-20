import {
  FileIcon, FileCode, FileImage, FileAudio, FileVideo, 
  FileArchive, FileText, FileSpreadsheet, FileJson
} from 'lucide-react';

export const FILE_CATEGORIES = {
  IMAGE: 'image',
  CODE: 'code',
  AUDIO: 'audio',
  VIDEO: 'video',
  ARCHIVE: 'archive',
  SPREADSHEET: 'spreadsheet',
  DOCUMENT: 'document',
  UNKNOWN: 'unknown'
};

export const THEME_COLORS = {
  pink: { bg: 'bg-pink-500/20', text: 'text-pink-400', rgb: '236,72,153' },
  amber: { bg: 'bg-amber-500/20', text: 'text-amber-400', rgb: '245,158,11' },
  orange: { bg: 'bg-orange-500/20', text: 'text-orange-400', rgb: '249,115,22' },
  purple: { bg: 'bg-purple-500/20', text: 'text-purple-400', rgb: '168,85,247' },
  indigo: { bg: 'bg-indigo-500/20', text: 'text-indigo-400', rgb: '99,102,241' },
  red: { bg: 'bg-red-500/20', text: 'text-red-400', rgb: '239,68,68' },
  emerald: { bg: 'bg-emerald-500/20', text: 'text-emerald-400', rgb: '16,185,129' },
  sky: { bg: 'bg-sky-500/20', text: 'text-sky-400', rgb: '14,165,233' },
  rose: { bg: 'bg-rose-500/20', text: 'text-rose-400', rgb: '244,63,94' },
  blue: { bg: 'bg-blue-500/20', text: 'text-blue-400', rgb: '59,130,246' },
  zinc: { bg: 'bg-zinc-500/20', text: 'text-zinc-400', rgb: '113,113,122' },
};

export function getFileCategoryInfo(filename) {
  const parts = (filename || '').split('.');
  const ext = parts.length > 1 ? parts.pop().toLowerCase() : '';
  const badge = ext ? ext.substring(0, 4).toUpperCase() : 'FILE';
  
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
    return { category: FILE_CATEGORIES.IMAGE, label: 'Image', color: 'pink', badge, Icon: FileImage };
  }
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'rs', 'go', 'php', 'rb', 'kt', 'swift', 'sh'].includes(ext)) {
    return { category: FILE_CATEGORIES.CODE, label: 'Source Code', color: 'amber', badge, Icon: FileCode };
  }
  if (['json', 'yaml', 'yml', 'xml', 'ini', 'env', 'toml'].includes(ext)) {
    return { category: FILE_CATEGORIES.CODE, label: 'Data', color: 'orange', badge, Icon: FileJson };
  }
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(ext)) {
    return { category: FILE_CATEGORIES.AUDIO, label: 'Audio', color: 'purple', badge, Icon: FileAudio };
  }
  if (['mp4', 'mov', 'webm', 'avi', 'mkv', 'wmv'].includes(ext)) {
    return { category: FILE_CATEGORIES.VIDEO, label: 'Video', color: 'indigo', badge, Icon: FileVideo };
  }
  if (['zip', 'tar', 'gz', 'rar', '7z', 'dmg', 'iso'].includes(ext)) {
    return { category: FILE_CATEGORIES.ARCHIVE, label: 'Archive', color: 'red', badge, Icon: FileArchive };
  }
  if (['csv', 'xls', 'xlsx'].includes(ext)) {
    return { category: FILE_CATEGORIES.SPREADSHEET, label: 'Spreadsheet', color: 'emerald', badge, Icon: FileSpreadsheet };
  }
  if (['md', 'txt', 'rtf'].includes(ext)) {
    return { category: FILE_CATEGORIES.DOCUMENT, label: 'Text', color: 'sky', badge, Icon: FileText };
  }
  if (['pdf'].includes(ext)) {
    return { category: FILE_CATEGORIES.DOCUMENT, label: 'PDF Document', color: 'rose', badge, Icon: FileText };
  }
  if (['doc', 'docx'].includes(ext)) {
    return { category: FILE_CATEGORIES.DOCUMENT, label: 'Word Document', color: 'blue', badge, Icon: FileText };
  }
  
  return { category: FILE_CATEGORIES.UNKNOWN, label: 'Document', color: 'zinc', badge, Icon: FileIcon };
}
