// File System Access API — folder picker and recursive file scanner.

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp', '.tiff', '.tif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v']);

export function isSupported() {
  return typeof window.showDirectoryPicker === 'function';
}

// Pick a folder with read+write permission so we can copy files into it
export async function pickFolder(mode = 'read') {
  return window.showDirectoryPicker({ mode });
}

// Recursively scan a directory handle and return all image/video file entries.
// Returns Array<{ handle: FileSystemFileHandle, relativePath: string, ext: string, isVideo: bool }>
// onProgress(scanned, total) is called periodically — total is unknown upfront, so we just pass scanned.
export async function scanDirectory(dirHandle, onProgress) {
  const results = [];
  await walkDir(dirHandle, '', results, onProgress);
  return results;
}

async function walkDir(dirHandle, prefix, results, onProgress) {
  for await (const [name, entry] of dirHandle) {
    if (entry.kind === 'directory') {
      // Skip hidden directories and the output folder
      if (name.startsWith('.') || name === 'Organized Photos') continue;
      await walkDir(entry, prefix ? `${prefix}/${name}` : name, results, onProgress);
    } else if (entry.kind === 'file') {
      const ext = getExt(name);
      if (IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext)) {
        results.push({
          handle:       entry,
          relativePath: prefix ? `${prefix}/${name}` : name,
          ext,
          isVideo:      VIDEO_EXT.has(ext),
        });
        onProgress?.(results.length);
      }
    }
  }
}

function getExt(name) {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}
