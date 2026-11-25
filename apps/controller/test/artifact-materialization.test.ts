import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@rbo/shared';
import { expect, it } from 'vitest';
import {
  publishPosixArtifact,
  publishWindowsArtifact,
} from '../src/execution/artifact-publication.js';
import { materializeArtifactToDestination } from '../src/execution/artifacts.js';
import { openDatabase } from '../src/storage/database.js';

it('publishes the complete artifact exactly once when two no-overwrite requests compete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rbo-artifact-materialize-'));
  const db = openDatabase(':memory:');
  try {
    db.exec(
      'CREATE TABLE artifacts (id TEXT PRIMARY KEY, path TEXT, sha256 TEXT, attempt_id TEXT)',
    );
    const sourcePath = join(root, 'stored.txt');
    const destinationName = 'output 吉.txt';
    const destinationPath = join(root, destinationName);
    const content = Buffer.alloc(192 * 1024 + 11, 'build artifact');
    await writeFile(sourcePath, content);
    db.prepare("INSERT INTO artifacts VALUES ('art_1', ?, ?, 'att_1')").run(
      sourcePath,
      sha256(content),
    );

    const copy = () =>
      materializeArtifactToDestination({
        db,
        artifactId: 'art_1',
        destinationPath,
        allowedDestinations: [root],
        overwrite: false,
      });
    const results = await Promise.allSettled([copy(), copy()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results).toContainEqual({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'Destination exists and overwrite=false' }),
    });
    expect(await readFile(destinationPath)).toEqual(content);
    expect((await readdir(root)).sort()).toEqual([destinationName, 'stored.txt']);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps the destination and removes staging when the stored artifact fails verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rbo-artifact-materialize-'));
  const db = openDatabase(':memory:');
  try {
    db.exec(
      'CREATE TABLE artifacts (id TEXT PRIMARY KEY, path TEXT, sha256 TEXT, attempt_id TEXT)',
    );
    const sourcePath = join(root, 'stored.txt');
    const destinationPath = join(root, 'output.txt');
    await writeFile(sourcePath, 'invalid');
    await writeFile(destinationPath, 'previous build artifact');
    const hash = sha256('verified build artifact');
    db.prepare("INSERT INTO artifacts VALUES ('art_1', ?, ?, 'att_1')").run(sourcePath, hash);

    const copy = () =>
      materializeArtifactToDestination({
        db,
        artifactId: 'art_1',
        destinationPath,
        allowedDestinations: [root],
        overwrite: true,
      });
    await expect(copy()).rejects.toThrow('Stored artifact hash mismatch');
    expect(await readFile(destinationPath, 'utf8')).toBe('previous build artifact');
    expect((await readdir(root)).sort()).toEqual(['output.txt', 'stored.txt']);

    await writeFile(sourcePath, 'verified build artifact');
    await expect(copy()).resolves.toEqual({ destination_path: destinationPath, sha256: hash });
    expect(await readFile(destinationPath, 'utf8')).toBe('verified build artifact');
    expect((await readdir(root)).sort()).toEqual(['output.txt', 'stored.txt']);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses to stage in a directory with an unapproved identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rbo-artifact-materialize-'));
  try {
    const parentPath = await realpath(root);
    const parentIdentity = await stat(parentPath, { bigint: true });
    const sourcePath = join(root, 'stored.txt');
    const content = 'build artifact';
    await writeFile(sourcePath, content);

    const publish = process.platform === 'win32' ? publishWindowsArtifact : publishPosixArtifact;
    await expect(
      publish({
        parentPath,
        parentIdentity: { dev: parentIdentity.dev, ino: parentIdentity.ino + 1n },
        sourcePath,
        destinationName: 'output.txt',
        sha256: sha256(content),
        overwrite: true,
      }),
    ).rejects.toThrow('Destination parent directory changed before materialization');
    expect(await readdir(root)).toEqual(['stored.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
