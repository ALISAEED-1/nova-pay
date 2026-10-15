import { randomBytes } from 'node:crypto';

/** Prefixed random ids (usr_…, cs_…) so an id says what it points at. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}
