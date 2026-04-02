// Copy files from source handles to a destination directory using File System Access API.
// Creates nested folder structure. Deduplicates filenames with _1, _2 suffix.

// plan: Array<{ handle: FileSystemFileHandle, destPath: string }>
// destRoot: FileSystemDirectoryHandle
// onProgress: (done, total, currentFile) => void
export async function executePlan(plan, destRoot, onProgress) {
  const seen = new Set(); // track used dest paths for deduplication

  for (let i = 0; i < plan.length; i++) {
    const { handle, destPath } = plan[i];
    const uniquePath = uniquify(destPath, seen);
    seen.add(uniquePath);

    onProgress?.(i, plan.length, handle.name);

    try {
      const file = await handle.getFile();
      await writeFile(destRoot, uniquePath, file);
    } catch (err) {
      console.warn(`Skipped ${handle.name}: ${err.message}`);
    }
  }

  onProgress?.(plan.length, plan.length, '');
}

async function writeFile(rootHandle, path, file) {
  const parts    = path.split('/');
  const fileName = parts.pop();
  let dir        = rootHandle;

  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }

  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable   = await fileHandle.createWritable();
  await file.stream().pipeTo(writable);
}

function uniquify(path, seen) {
  if (!seen.has(path)) return path;

  const dotIdx = path.lastIndexOf('.');
  const base   = dotIdx >= 0 ? path.slice(0, dotIdx)  : path;
  const ext    = dotIdx >= 0 ? path.slice(dotIdx)      : '';

  for (let n = 1; ; n++) {
    const candidate = `${base}_${n}${ext}`;
    if (!seen.has(candidate)) return candidate;
  }
}
