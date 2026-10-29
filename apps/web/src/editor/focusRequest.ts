// A note just created in the app: its editor takes the focus once it is ready (type right away). Kept apart from
// NoteView so the dialogs that create notes do not load the editor (it comes with the first note).
let request: string | null = null;

export const focusWhenOpened = (mountId: string, path: string) => {
  request = `${mountId}:${path}`;
};

/** Whether the note just opened asked for the focus – answered once. */
export function takeFocusRequest(mountId: string, path: string): boolean {
  if (request !== `${mountId}:${path}`) return false;
  request = null;
  return true;
}
