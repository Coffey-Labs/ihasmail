import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/*
 * The guard's answers, and which of them the dialog leans on.
 *
 * It shipped with "Discard changes" as the only choice carrying a colour, which
 * made losing the work the easy thing to click on a dialog whose entire purpose
 * is to stop that (#175). The emphasis belongs on the safe answer; the
 * destructive one stays legible as destructive without being the loudest thing
 * in the box.
 */

const choiceDialog = vi.fn();
vi.mock("@/ui/dialog", () => ({ choiceDialog: (...args: unknown[]) => choiceDialog(...args) }));

const { confirmLeaveUnsaved, useUnsavedChanges } = await import("@/lib/unsavedChanges");

interface Choice { value: string; label: string; hint?: string; danger?: boolean; primary?: boolean }

const save = vi.fn(async () => true);
const discard = vi.fn();

function Editor() {
  useUnsavedChanges({ dirty: true, save, discard, message: "Your filters have unsaved changes." });
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** One dirty editor on screen, which is what registers anything at all. */
function mountDirtyEditor() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Editor />));
}

const asked = () => choiceDialog.mock.calls[0]![0] as { choices: Choice[]; cancelLabel: string; title: string; message: string };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  choiceDialog.mockReset().mockResolvedValue(null);
  save.mockClear().mockResolvedValue(true);
  discard.mockClear();
  mountDirtyEditor();
});

afterEach(() => {
  act(() => root!.unmount());
  host!.remove();
  root = null;
  host = null;
});

describe("the unsaved-changes guard", () => {
  it("highlights saving, not discarding", async () => {
    await confirmLeaveUnsaved();
    const [saveChoice, discardChoice] = asked().choices;
    expect(saveChoice!.primary).toBe(true);
    expect(discardChoice!.primary).toBeFalsy();
  });

  it("still says which answer is the destructive one", async () => {
    await confirmLeaveUnsaved();
    const [saveChoice, discardChoice] = asked().choices;
    expect(discardChoice!.danger).toBe(true);
    expect(discardChoice!.hint).toBeTruthy();
    expect(saveChoice!.danger).toBeFalsy();
  });

  it("offers saving first, and staying as the way out", async () => {
    await confirmLeaveUnsaved();
    expect(asked().choices.map((c) => c.value)).toEqual(["save", "discard"]);
    expect(asked().cancelLabel).toBeTruthy();
  });

  it("says what is about to be lost, in the editor's own words", async () => {
    await confirmLeaveUnsaved();
    expect(asked().message).toBe("Your filters have unsaved changes.");
  });

  it("stays put when the dialog is dismissed, and loses nothing", async () => {
    choiceDialog.mockResolvedValue(null);
    await expect(confirmLeaveUnsaved()).resolves.toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("saves and goes when saving is chosen", async () => {
    choiceDialog.mockResolvedValue("save");
    await expect(confirmLeaveUnsaved()).resolves.toBe(true);
    expect(save).toHaveBeenCalledOnce();
  });

  it("holds you on the page when the save fails", async () => {
    choiceDialog.mockResolvedValue("save");
    save.mockResolvedValue(false);
    await expect(confirmLeaveUnsaved()).resolves.toBe(false);
  });

  it("discards and goes when discarding is chosen", async () => {
    choiceDialog.mockResolvedValue("discard");
    await expect(confirmLeaveUnsaved()).resolves.toBe(true);
    expect(discard).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });
});
