// Linux-only export from private fixture evidence into a pinned private directory.
// No destination pathname is reopened after pinning, including for chmod.
import { constants, openSync, closeSync, fstatSync, readdirSync, readSync, writeSync,
  fchmodSync, unlinkSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { bounds, check } from './model.ts';

export const artifactNames = Object.freeze(['operator-result.json', 'summary.json', 'source-manifest.json',
  'native-migrations.json', 'attempts.json', 'preparations.json', 'cleanup.json', 'scenarios.json',
  'provider-ledger.ndjson', 'resources.json'] as const);

function directory(path: string): number {
  check(isAbsolute(path) && normalize(path) === path && !path.includes('\0'), 'artifact-export-path');
  return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

export interface ArtifactExport {
  copy(sourceDirectory: string, name: string): void;
  close(): void;
}

export function openArtifactExport(destination: string): ArtifactExport {
  check(process.platform === 'linux' && typeof process.geteuid === 'function', 'artifact-export-linux');
  const destinationFD = directory(destination), anchor = '/proc/self/fd/' + destinationFD;
  try {
    const state = fstatSync(destinationFD);
    check(state.isDirectory() && state.uid === process.geteuid() && (state.mode & 0o777) === 0o700, 'artifact-export-private-owner');
    check(readdirSync(anchor).length === 0, 'artifact-export-fresh-directory');
  } catch (error) { closeSync(destinationFD); throw error; }
  let closed = false, exportedBytes = 0;
  return Object.freeze({
    copy(sourceDirectory: string, name: string) {
      check(!closed, 'artifact-export-closed');
      check(artifactNames.some(allowed => allowed === name), 'artifact-export-name');
      let sourceDirectoryFD: number | undefined, sourceFD: number | undefined, outputFD: number | undefined;
      const output = anchor + '/' + name;
      let created = false, complete = false;
      try {
        sourceDirectoryFD = directory(sourceDirectory);
        sourceFD = openSync('/proc/self/fd/' + sourceDirectoryFD + '/' + name,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const state = fstatSync(sourceFD);
        check(state.isFile() && state.nlink === 1 && Number.isSafeInteger(state.size) &&
          state.size <= bounds.artifactBytes && exportedBytes + state.size <= bounds.artifactBytes, 'artifact-export-source-bound');
        outputFD = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        created = true;
        fchmodSync(outputFD, 0o600);
        const buffer = Buffer.alloc(65_536);
        let copied = 0;
        for (;;) {
          const size = readSync(sourceFD, buffer, 0, buffer.length, null);
          if (!size) break;
          copied += size;
          check(copied <= state.size, 'artifact-export-source-changed');
          for (let offset = 0; offset < size;) {
            const written = writeSync(outputFD, buffer, offset, size - offset);
            check(written > 0, 'artifact-export-write'); offset += written;
          }
        }
        const after = fstatSync(sourceFD);
        check(copied === state.size && after.size === state.size && after.mtimeMs === state.mtimeMs &&
          after.ctimeMs === state.ctimeMs, 'artifact-export-source-changed');
        exportedBytes += copied; complete = true;
      } finally {
        try { if (outputFD !== undefined) closeSync(outputFD); }
        finally {
          try { if (sourceFD !== undefined) closeSync(sourceFD); }
          finally {
            try { if (sourceDirectoryFD !== undefined) closeSync(sourceDirectoryFD); }
            finally { if (created && !complete) unlinkSync(output); }
          }
        }
      }
    },
    close() { if (!closed) { closed = true; closeSync(destinationFD); } }
  });
}
