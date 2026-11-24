import { stripJsonExtension } from '@/features/authFiles/identity';

/** Display only: keep mutation filenames and quota cache identities untouched. */
export function compactCredentialLabel(name: string): string {
  return stripJsonExtension(name).replace(/^([^-]+)-[a-f0-9]{8,64}-(.+)$/i, '$1-$2');
}
