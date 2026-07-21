import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveAgentStateDir,
  resolveControllerDataDir,
  resolveDefaultRboRoot,
} from '../src/layout.js';

const unixHome = '/home/alice';
const winHome = 'C:\\Users\\alice';

describe('RBO default layout paths', () => {
  it('uses ~/.rbo for controller and ~/.rbo/agent for agent when env is unset', () => {
    const options = { env: {}, home: unixHome };
    expect(resolveDefaultRboRoot(options)).toBe(join(unixHome, '.rbo'));
    expect(resolveControllerDataDir(options)).toBe(join(unixHome, '.rbo'));
    expect(resolveAgentStateDir(options)).toBe(join(unixHome, '.rbo', 'agent'));
  });

  it('derives agent state from RBO_DATA_DIR when set', () => {
    const options = { env: { RBO_DATA_DIR: '/data/rbo' }, home: unixHome };
    expect(resolveControllerDataDir(options)).toBe('/data/rbo');
    expect(resolveAgentStateDir(options)).toBe(join('/data/rbo', 'agent'));
  });

  it('prefers RBO_AGENT_STATE_DIR over RBO_DATA_DIR-derived agent path', () => {
    const options = {
      env: {
        RBO_DATA_DIR: '/data/rbo',
        RBO_AGENT_STATE_DIR: '/custom/agent-state',
      },
      home: unixHome,
    };
    expect(resolveControllerDataDir(options)).toBe('/data/rbo');
    expect(resolveAgentStateDir(options)).toBe('/custom/agent-state');
  });

  it('places .rbo under homedir on Windows, not LOCALAPPDATA', () => {
    const options = {
      env: {
        LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        USERPROFILE: winHome,
      },
      home: winHome,
    };
    expect(resolveControllerDataDir(options)).toBe(join(winHome, '.rbo'));
    expect(resolveAgentStateDir(options)).toBe(join(winHome, '.rbo', 'agent'));
    expect(resolveControllerDataDir(options)).not.toContain('AppData');
  });
});
