import { ulid } from 'ulid';

export type IdPrefix = 'job' | 'att' | 'agt' | 'snp' | 'art' | 'lease' | 'msg' | 'req';

const ID_REGEX = /^(job|att|agt|snp|art|lease|msg|req)_[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;

export function generateId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

export function parseIdPrefix(id: string): IdPrefix | null {
  if (!isValidId(id)) {
    return null;
  }
  const parts = id.split('_');
  return parts[0] as IdPrefix;
}

export function isValidId(id: string, expectedPrefix?: IdPrefix): boolean {
  if (typeof id !== 'string' || !ID_REGEX.test(id)) {
    return false;
  }
  if (expectedPrefix && !id.startsWith(`${expectedPrefix}_`)) {
    return false;
  }
  return true;
}
