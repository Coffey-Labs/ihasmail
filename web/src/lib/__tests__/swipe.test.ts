import { describe, expect, it } from "vitest";
import { SWIPE_CHOICES, describeSwipe, type SwipeAction } from "../swipe";

/**
 * A swipe names what it is about to do on a coloured strip the reader sees for
 * about a third of a second before letting go. These check that the name is
 * true in the folder it is being read in — which is the whole reason the
 * descriptor exists rather than a fixed label per setting.
 */

const inbox = { role: "inbox", unread: false, starred: false };

describe("describeSwipe", () => {
  it("offers nothing for a direction turned off", () => {
    expect(describeSwipe("none", inbox)).toBe(null);
  });

  it("refuses to archive out of the archive", () => {
    expect(describeSwipe("archive", { ...inbox, role: "archive" })).toBe(null);
    expect(describeSwipe("archive", inbox)).toMatchObject({ label: "Archive", removes: true });
  });

  it("says out loud that a delete from Deleted Items is permanent", () => {
    expect(describeSwipe("delete", inbox)?.label).toBe("Delete");
    expect(describeSwipe("delete", { ...inbox, role: "trash" })?.label).toBe("Delete forever");
  });

  it("turns the spam action around inside the junk folder", () => {
    expect(describeSwipe("spam", inbox)).toMatchObject({ label: "Report spam", icon: "spam" });
    expect(describeSwipe("spam", { ...inbox, role: "junk" })).toMatchObject({ label: "Not spam", icon: "not-spam" });
  });

  it("has no opinion on whether your own mail is spam", () => {
    expect(describeSwipe("spam", { ...inbox, role: "drafts" })).toBe(null);
    expect(describeSwipe("spam", { ...inbox, role: "sent" })).toBe(null);
  });

  it("names the state a toggle is about to set, and carries it", () => {
    expect(describeSwipe("read", { ...inbox, unread: true })).toMatchObject({ label: "Mark as read", icon: "read", on: true });
    expect(describeSwipe("read", { ...inbox, unread: false })).toMatchObject({ label: "Mark as unread", icon: "unread", on: false });
    expect(describeSwipe("star", { ...inbox, starred: false })).toMatchObject({ label: "Add star", on: true });
    expect(describeSwipe("star", { ...inbox, starred: true })).toMatchObject({ label: "Remove star", on: false });
  });

  it("brings a row home for the actions that open something instead", () => {
    // The row has to be back under the finger before the folder picker covers
    // the list, or it is still hanging half-open when the picker closes again.
    expect(describeSwipe("move", inbox)).toMatchObject({ label: "Move to…", removes: false });
    for (const action of ["archive", "delete", "spam"] as const) {
      expect(describeSwipe(action, inbox)?.removes).toBe(true);
    }
  });

  it("can describe everything the settings picker offers", () => {
    // A choice the picker offers and the list cannot describe is a direction
    // that silently does nothing — the one failure nobody would report.
    for (const { value } of SWIPE_CHOICES) {
      const d = describeSwipe(value as SwipeAction, inbox);
      if (value === "none") expect(d).toBe(null);
      else expect(d?.label).toBeTruthy();
    }
  });
});
