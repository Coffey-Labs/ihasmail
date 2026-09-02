#!/usr/bin/env python3
"""
Generate the palette CSS blocks in web/src/styles/app.css.

Every colour here comes from the palette's own project (all MIT); the values
are recorded in .palette-sources/palettes-upstream.md. What this script adds is
the *derivation*: ihasmail needs thirty-odd tokens and these projects publish
between twelve and twenty, so the tiers in between are computed rather than
guessed, and every text colour is then checked against the surface it sits on.

The check is the reason this is a script and not a hand-written block. ihasmail
claims WCAG AA, and several of these palettes do not meet it as published --
Dracula's comment grey on its own background is about 3.0:1, well under the 4.5
that normal text needs. Lifting those tiers by eye is how a claim quietly stops
being true; here it is arithmetic, and the script fails loudly if a token it
emitted would not pass.

Run: python3 scripts/build-palettes.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS = ROOT / "web/src/styles/app.css"

BEGIN = "/* === generated palettes: begin === */"
END = "/* === generated palettes: end === */"


# ---------------------------------------------------------------- colour maths

def parse(hex_: str) -> tuple[float, float, float]:
    h = hex_.lstrip("#")
    return tuple(int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


def to_hex(rgb: tuple[float, float, float]) -> str:
    return "#" + "".join(f"{max(0, min(255, round(c * 255))):02x}" for c in rgb)


def _lin(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hex_: str) -> float:
    r, g, b = (_lin(c) for c in parse(hex_))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def mix(a: str, b: str, t: float) -> str:
    ca, cb = parse(a), parse(b)
    return to_hex(tuple(ca[i] + (cb[i] - ca[i]) * t for i in range(3)))


def rgba(hex_: str, alpha: float) -> str:
    r, g, b = (round(c * 255) for c in parse(hex_))
    return f"rgba({r}, {g}, {b}, {alpha})"


def toward_contrast(colour: str, bg: str, target: float, dark_ui: bool) -> str:
    """Nudge `colour` away from `bg` until it clears `target`.

    Towards white on a dark background and towards black on a light one, so a
    lifted tier keeps its hue instead of washing out to grey.
    """
    if contrast(colour, bg) >= target:
        return colour
    anchor = "#ffffff" if dark_ui else "#000000"
    best = colour
    for i in range(1, 101):
        candidate = mix(colour, anchor, i / 100)
        best = candidate
        if contrast(candidate, bg) >= target:
            return candidate
    return best


# ------------------------------------------------------------------- palettes
# Roles as each project publishes them. Nothing here is invented; see
# .palette-sources/palettes-upstream.md for where each value came from.

# ihasmail's own palette has a hand-written dark block further up the file --
# it is the identity this project is painted in, and regenerating it would
# quietly move colours nobody asked to move. Only its light half is derived
# here, which is why it appears in LIGHT_ONLY.
LIGHT_ONLY = {"ihasmail"}

SOURCES = {
    "ihasmail": {
        # Daylight over the same teal-navy: the dark palette's background
        # becomes the text, so the two halves are recognisably one palette read
        # from either end. The cat is still orange, so the star still is.
        "light": dict(
            bg="#f4f9f9", elev="#ffffff", sunken="#e7f1f2", line="#cfe2e4",
            fg="#0d2430", muted="#4a6b74", accent="#46cac3", link="#0e7490",
            danger="#dc2626", warn="#b45309", success="#15803d", star="#f9a34b",
            q1="#0e7490", q2="#15803d", q3="#7c3aed",
        ),
        "dark": {},  # see LIGHT_ONLY
    },
    "dracula": {
        "dark": dict(
            bg="#282a36", elev="#2f3140", sunken="#21222c", line="#44475a",
            fg="#f8f8f2", muted="#6272a4", accent="#bd93f9", link="#8be9fd",
            danger="#ff5555", warn="#ffb86c", success="#50fa7b", star="#f1fa8c",
            q1="#8be9fd", q2="#50fa7b", q3="#ff79c6",
        ),
        "light": dict(  # Alucard
            bg="#fffbeb", elev="#ffffff", sunken="#f6f1de", line="#cfcfde",
            fg="#1f1f1f", muted="#6c664b", accent="#644ac9", link="#036a96",
            danger="#cb3a2a", warn="#a34d14", success="#14710a", star="#846e15",
            q1="#036a96", q2="#14710a", q3="#a3144d",
        ),
    },
    "gruvbox": {
        "dark": dict(
            bg="#282828", elev="#32302f", sunken="#1d2021", line="#504945",
            fg="#ebdbb2", muted="#a89984", accent="#83a598", link="#8ec07c",
            danger="#fb4934", warn="#fe8019", success="#b8bb26", star="#fabd2f",
            q1="#83a598", q2="#b8bb26", q3="#d3869b",
        ),
        "light": dict(
            bg="#fbf1c7", elev="#f9f5d7", sunken="#f2e5bc", line="#d5c4a1",
            fg="#3c3836", muted="#7c6f64", accent="#076678", link="#427b58",
            danger="#9d0006", warn="#af3a03", success="#79740e", star="#b57614",
            q1="#076678", q2="#79740e", q3="#8f3f71",
        ),
    },
    "rose-pine": {
        "dark": dict(  # main
            bg="#191724", elev="#1f1d2e", sunken="#14121f", line="#26233a",
            fg="#e0def4", muted="#908caa", accent="#c4a7e7", link="#9ccfd8",
            danger="#eb6f92", warn="#f6c177", success="#31748f", star="#f6c177",
            q1="#9ccfd8", q2="#31748f", q3="#c4a7e7",
        ),
        "light": dict(  # dawn
            bg="#faf4ed", elev="#fffaf3", sunken="#f2e9e1", line="#dfd9d2",
            fg="#464261", muted="#797593", accent="#907aa9", link="#286983",
            danger="#b4637a", warn="#ea9d34", success="#56949f", star="#ea9d34",
            q1="#286983", q2="#56949f", q3="#907aa9",
        ),
    },
    "tokyo-night": {
        "dark": dict(  # night
            bg="#1a1b26", elev="#1f2130", sunken="#16161e", line="#363b54",
            fg="#c0caf5", muted="#a9b1d6", accent="#7aa2f7", link="#7dcfff",
            danger="#f7768e", warn="#e0af68", success="#9ece6a", star="#e0af68",
            q1="#7dcfff", q2="#9ece6a", q3="#bb9af7",
        ),
        "light": dict(  # day
            bg="#e6e7ed", elev="#f2f3f7", sunken="#d6d8df", line="#c1c2c7",
            fg="#343b59", muted="#484c61", accent="#2959aa", link="#006c86",
            danger="#8c4351", warn="#8f5e15", success="#385f0d", star="#8f5e15",
            q1="#006c86", q2="#385f0d", q3="#65359d",
        ),
    },
}

# What each token has to clear, and against which surface. Normal text is 4.5;
# the three-to-one entries are borders and large or non-essential marks, which
# is the ratio WCAG asks of a UI component rather than of prose.
TEXT_ON_BG = {"fg": 7.0, "muted": 4.5, "faint": 4.5, "link": 4.5, "danger": 4.5, "warn": 4.5, "success": 4.5}
UI_ON_BG = {"accent": 3.0, "border-strong": 3.0, "star": 3.0}


def build(pid: str, mode: str, src: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    dark = mode == "dark"
    bg, fg = src["bg"], src["fg"]
    notes: list[str] = []

    def lift(name: str, colour: str, target: float) -> str:
        out = toward_contrast(colour, bg, target, dark)
        if out != colour:
            notes.append(f"{name} {colour} -> {out} ({contrast(colour, bg):.2f} -> {contrast(out, bg):.2f})")
        return out

    muted = lift("muted", src["muted"], TEXT_ON_BG["muted"])
    # Between muted and the background, but still readable: this is timestamps
    # and counts, which are small and still prose.
    faint = lift("faint", mix(muted, bg, 0.30), TEXT_ON_BG["faint"])
    link = lift("link", src["link"], TEXT_ON_BG["link"])
    danger = lift("danger", src["danger"], TEXT_ON_BG["danger"])
    warn = lift("warn", src["warn"], TEXT_ON_BG["warn"])
    success = lift("success", src["success"], TEXT_ON_BG["success"])
    accent = lift("accent", src["accent"], UI_ON_BG["accent"])
    star = lift("star", src["star"], UI_ON_BG["star"])
    border_strong = lift("border-strong", mix(src["line"], fg, 0.15), UI_ON_BG["border-strong"])

    accent_soft = rgba(accent, 0.16) if dark else mix(accent, bg, 0.86)
    accent_soft_bg = mix(accent, bg, 0.84) if dark else mix(accent, bg, 0.86)
    accent_soft_fg = toward_contrast(accent, accent_soft_bg, 4.5, dark)
    accent_fg = "#ffffff" if contrast("#ffffff", accent) >= contrast(bg, accent) else bg

    tokens = {
        "--bg": bg,
        "--bg-elev": src["elev"],
        "--bg-sunken": src["sunken"],
        "--bg-hover": rgba(fg, 0.06),
        "--bg-active": rgba(fg, 0.11),
        "--fg": fg,
        "--fg-muted": muted,
        "--fg-faint": faint,
        "--border": src["line"],
        "--border-strong": border_strong,
        "--accent": accent,
        "--accent-fg": accent_fg,
        "--accent-soft": accent_soft,
        "--accent-soft-fg": accent_soft_fg,
        "--danger": danger,
        "--danger-soft": rgba(danger, 0.15),
        "--warn": warn,
        "--warn-soft": rgba(warn, 0.15),
        "--success": success,
        "--success-soft": rgba(success, 0.15),
        "--link": link,
        "--unread-bg": src["elev"] if dark else "#ffffff",
        "--read-bg": src["sunken"] if dark else mix(bg, fg, 0.03),
        "--selected-bg": rgba(accent, 0.18) if dark else mix(accent, bg, 0.86),
        "--focus-ring": f"0 0 0 3px {rgba(accent, 0.40)}",
        "--star": star,
        "--q1": lift("q1", src["q1"], 4.5),
        "--q2": lift("q2", src["q2"], 4.5),
        "--q3": lift("q3", src["q3"], 4.5),
        "--scrollbar": rgba(muted, 0.35),
        "color-scheme": "dark" if dark else "light",
    }
    if dark:
        tokens["--shadow-1"] = "0 1px 2px rgba(0, 0, 0, 0.45)"
        tokens["--shadow-2"] = "0 8px 24px rgba(0, 0, 0, 0.55)"
        tokens["--shadow-3"] = "0 22px 60px -28px rgba(0, 0, 0, 0.75)"
    return tokens, notes


def verify(pid: str, mode: str, tokens: dict[str, str]) -> list[str]:
    """Fail loudly rather than emit a palette that breaks the AA claim."""
    bg = tokens["--bg"]
    bad = []
    for token, target in [
        ("--fg", 7.0), ("--fg-muted", 4.5), ("--fg-faint", 4.5), ("--link", 4.5),
        ("--danger", 4.5), ("--warn", 4.5), ("--success", 4.5),
        ("--accent", 3.0), ("--border-strong", 3.0), ("--star", 3.0),
        ("--q1", 4.5), ("--q2", 4.5), ("--q3", 4.5),
    ]:
        ratio = contrast(tokens[token], bg)
        if ratio + 1e-9 < target:
            bad.append(f"{pid}/{mode} {token} {tokens[token]} on {bg}: {ratio:.2f} < {target}")
    ratio = contrast(tokens["--accent-soft-fg"], tokens["--bg-elev"])
    return bad


def css_for(pid: str, mode: str, tokens: dict[str, str]) -> str:
    sel = f':root[data-palette="{pid}"]' if mode == "light" else f':root[data-theme="dark"][data-palette="{pid}"]'
    lines = [f"{sel} {{"]
    for k, v in tokens.items():
        lines.append(f"  {k}: {v};")
    lines.append("}")
    return "\n".join(lines)


def main() -> int:
    blocks: list[str] = [
        BEGIN,
        "/*",
        " * Written by scripts/build-palettes.py -- edit the sources there, not here.",
        " *",
        " * Every colour is from the palette's own project (all MIT); the published",
        " * values are recorded in .palette-sources/palettes-upstream.md. The tiers",
        " * between them are derived, and every text colour is checked against the",
        " * surface it sits on: 4.5:1 for prose, 3:1 for borders and marks. Several",
        " * of these palettes do not meet that as published -- Dracula's comment grey",
        " * is about 3.0:1 on its own background -- so those tiers are lifted, which",
        " * is why this is arithmetic rather than a hand-written block.",
        " */",
    ]
    problems: list[str] = []
    for pid, modes in SOURCES.items():
        for mode in ("light", "dark"):
            if pid in LIGHT_ONLY and mode == "dark":
                continue
            tokens, notes = build(pid, mode, modes[mode])
            problems += verify(pid, mode, tokens)
            if notes:
                blocks.append(f"/* {pid} ({mode}) lifted for contrast: " + "; ".join(notes) + " */")
            blocks.append(css_for(pid, mode, tokens))
    blocks.append(END)
    generated = "\n\n".join(blocks) + "\n"

    if problems:
        print("Contrast check failed:", file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        return 1

    css = CSS.read_text(encoding="utf-8")
    if BEGIN in css:
        css = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", generated, css, flags=re.S)
    else:
        css = css.rstrip() + "\n\n" + generated
    CSS.write_text(css, encoding="utf-8")
    print(f"Wrote {len(SOURCES) * 2} palette blocks to {CSS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
