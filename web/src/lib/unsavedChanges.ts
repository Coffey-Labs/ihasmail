import { useEffect, useRef } from "react";
import { choiceDialog } from "@/ui/dialog";
import { t } from "@/lib/i18n";

/**
 * Editors that would lose work if you walked away from them.
 *
 * The filter editors keep their edits in component state, so every way out of
 * the page -- a settings link, the app rail, the Rules/Scripts switch -- threw
 * them away without a word, and the only sign there had been anything to lose
 * was a Save button that a screenful of rules had already pushed past the
 * bottom of the window. That is issue #175.
 *
 * An editor registers what it has pending here; navigation asks before it
 * happens. The question is deliberately not a yes/no: "leave without saving?"
 * makes losing the work the easy answer and saving it the one you have to back
 * out and find, when saving is what almost everybody wants.
 */
export interface UnsavedChanges {
  /** Whether anything would be lost by leaving right now. */
  dirty: boolean;
  /**
   * Persist the edits. `false` keeps you where you are: a save that failed is
   * exactly the moment not to navigate, because the edits only exist here.
   */
  save: () => Promise<boolean>;
  /** Throw the edits away. */
  discard: () => void;
  /** Already translated, and specific: it says what is about to be lost. */
  message: string;
}

/**
 * Held by reference rather than by value, so the callbacks the dialog runs are
 * the ones from the editor's latest render and not from whenever it mounted.
 */
type Slot = { current: UnsavedChanges };

const slots = new Set<Slot>();

/** Register this editor's pending edits for as long as it is on screen. */
export function useUnsavedChanges(changes: UnsavedChanges): void {
  const slot = useRef(changes);
  slot.current = changes;
  useEffect(() => {
    slots.add(slot);
    return () => {
      slots.delete(slot);
    };
  }, []);
  /*
   * Reloading and closing the tab are the browser's to ask about, and all it
   * will show is its own generic wording -- custom text was removed years ago.
   * Generic is still better than silent, and it costs one listener, armed only
   * while there is something to lose.
   */
  useEffect(() => {
    if (!changes.dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changes.dirty]);
}

/** Whether leaving now would lose anything. Cheap enough for every navigation. */
export function hasUnsavedChanges(): boolean {
  for (const slot of slots) if (slot.current.dirty) return true;
  return false;
}

/**
 * Ask about anything pending. Resolves true when it is safe to go.
 *
 * Dismissing the dialog -- Escape, the backdrop, the close button -- is not
 * one of the answers, so it cannot be mistaken for "discard": it leaves you on
 * the page with the edits intact.
 */
export async function confirmLeaveUnsaved(): Promise<boolean> {
  /*
   * A snapshot, not the live set. `save` and `discard` both make an editor
   * clean, but not until React has re-rendered it, and re-reading `slots`
   * between questions would find the same editor still dirty and ask twice.
   */
  for (const slot of [...slots]) {
    const pending = slot.current;
    if (!pending.dirty) continue;
    const answer = await choiceDialog({
      title: t("Save your changes?"),
      message: pending.message,
      choices: [
        // Save is the highlighted one. Highlighting the destructive answer makes
        // losing the work the easy thing to click, which is the failure this
        // dialog exists to prevent -- #175, after the guard shipped with the
        // emphasis the wrong way round.
        { value: "save", label: t("Save changes"), primary: true },
        { value: "discard", label: t("Discard changes"), hint: t("What you changed here will be lost."), danger: true },
      ],
      cancelLabel: t("Stay here"),
    });
    if (answer === null) return false;
    if (answer === "discard") {
      pending.discard();
      continue;
    }
    if (!(await pending.save())) return false;
  }
  return true;
}
