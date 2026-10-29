// Notes currently open in their encrypted form: uploads and drawings into them get encrypted too. Apart from
// crypto.ts so the drawing dialog of the shell can ask without loading the encryption code.
const sealedNotes = new Set<string>();
const keyOf = (mountId: string, path: string) => `${mountId}:${path}`;

export const markSealed = (mountId: string, path: string, on: boolean) => (on ? sealedNotes.add(keyOf(mountId, path)) : sealedNotes.delete(keyOf(mountId, path)));
export const isSealed = (mountId: string, path: string) => sealedNotes.has(keyOf(mountId, path));
