import { app } from 'electron';
import { execFile, ExecFileOptions } from 'child_process';
import path from 'path';

export type MediaBinary = 'ffmpeg' | 'ffprobe';

export function mediaBinaryPath(binary: MediaBinary): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', binary);
  // Webpack rewrites the static package's __dirname, so resolve from the
  // development application's real root instead. Production uses Resources/bin.
  return path.join(app.getAppPath(), 'node_modules', 'ffmpeg-ffprobe-static', binary);
}

export function runMediaBinary(
  binary: MediaBinary,
  args: string[],
  options: ExecFileOptions = {},
): Promise<{ stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      mediaBinaryPath(binary),
      args,
      { maxBuffer: 32 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (error) {
          const details = stderr ? stderr.toString() : error.message;
          reject(new Error(`${binary} failed: ${details}`));
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });
}
