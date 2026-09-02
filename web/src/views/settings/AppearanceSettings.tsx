import { useSettings } from "@/store/settings";
import { PALETTES, effectiveMode, type Mode, type PaletteId } from "@/lib/palette";
import { Switch, useIsTouch } from "@/ui/misc";
import { SWIPE_CHOICES, type SwipeAction } from "@/lib/swipe";
import { TRANSLATION_ISSUE_URL, UI_LANGUAGES } from "@/lib/languages";
import { t as translate, tNode } from "@/lib/i18n";
import { isEnforced } from "@/lib/settingsPolicy";

/**
 * A swatch for each palette, drawn from the colours that palette actually
 * paints, so a card looks like what picking it does. Kept as data rather than
 * inline ternaries so a sixth palette does not mean editing a conditional in
 * three places.
 */
const PALETTE_PREVIEW: Record<PaletteId, { light: string; dark: string }> = {
  default: { light: "#f6f8fa", dark: "#0b1220" },
  // The ihasmail.org palette: its background, with its teal and the logo's
  // orange showing.
  ihasmail: { light: "linear-gradient(135deg,#f4f9f9 0%,#e7f1f2 55%,#379e98 55%,#379e98 78%,#c5813b 78%)", dark: "linear-gradient(135deg,#0d2430 0%,#12303e 55%,#46cac3 55%,#46cac3 78%,#f9a34b 78%)" },
  dracula: {
    light: "linear-gradient(135deg,#fffbeb 0%,#fffbeb 55%,#644ac9 55%,#644ac9 78%,#a3144d 78%)",
    dark: "linear-gradient(135deg,#282a36 0%,#2f3140 55%,#bd93f9 55%,#bd93f9 78%,#ff79c6 78%)",
  },
  gruvbox: {
    light: "linear-gradient(135deg,#fbf1c7 0%,#f2e5bc 55%,#076678 55%,#076678 78%,#af3a03 78%)",
    dark: "linear-gradient(135deg,#282828 0%,#32302f 55%,#83a598 55%,#83a598 78%,#fe8019 78%)",
  },
  "rose-pine": {
    light: "linear-gradient(135deg,#faf4ed 0%,#fffaf3 55%,#907aa9 55%,#907aa9 78%,#d7827e 78%)",
    dark: "linear-gradient(135deg,#191724 0%,#1f1d2e 55%,#c4a7e7 55%,#c4a7e7 78%,#ebbcba 78%)",
  },
  "tokyo-night": {
    light: "linear-gradient(135deg,#e6e7ed 0%,#d6d8df 55%,#2959aa 55%,#2959aa 78%,#8c4351 78%)",
    dark: "linear-gradient(135deg,#1a1b26 0%,#1f2130 55%,#7aa2f7 55%,#7aa2f7 78%,#bb9af7 78%)",
  },
};

const MODES: Array<{ id: Mode; label: string }> = [
  { id: "system", label: "Match system" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const ACCENTS = [
  { id: "teal", color: "#0f766e" },
  { id: "blue", color: "#2563eb" },
  { id: "purple", color: "#7c3aed" },
  { id: "rose", color: "#e11d48" },
  { id: "orange", color: "#ea580c" },
  { id: "green", color: "#16a34a" },
];

export function AppearanceSettings() {
  const s = useSettings((st) => st.settings);
  const update = useSettings((st) => st.update);
  const prefersDark = Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const isTouch = useIsTouch();
  const chosen = UI_LANGUAGES.find((l) => l.tag === s.uiLanguage);
  const betaChosen = Boolean(chosen?.beta);
  return (
    <div>
      <h1>{translate("Appearance")}</h1>
      <p className="lead">{translate("Make ihasmail yours.")}</p>
      <h2>{translate("Theme")}</h2>
      <div className="mode-switch" role="group" aria-label={translate("Light or dark")}>
        {MODES.map((m) => (
          <button key={m.id} className={s.mode === m.id ? "active" : ""} onClick={() => update({ mode: m.id })}>
            {translate(m.label)}
          </button>
        ))}
      </div>
      <div className="theme-grid" style={{ marginTop: 12 }}>
        {PALETTES.map((p) => {
          const shown = effectiveMode(s.mode, prefersDark);
          return (
            <button key={p.id} className={`theme-card ${s.palette === p.id ? "active" : ""}`} onClick={() => update({ palette: p.id })}>
              <div className="preview" style={{ background: PALETTE_PREVIEW[p.id][shown] || PALETTE_PREVIEW[p.id].dark }} />
              <span className="notranslate" translate="no">{p.name}</span>
            </button>
          );
        })}
      </div>
      <p className="hint" style={{ marginTop: 10 }}>
        {translate("Dracula, Gruvbox, Rosé Pine and Tokyo Night are the work of their own projects and are used under the MIT licence; the shades between their published colours are derived, and every one of them is checked for contrast. The accent colour below still applies over any of them.")}
      </p>
      <Switch
        checked={s.themeMessageBody}
        onChange={(v) => update({ themeMessageBody: v })}
        label={translate("Apply the theme to messages too")}
        hint={translate("Plain-text mail already follows the theme. With this on, HTML mail that brings no colours of its own does as well, instead of sitting on a white card. Messages that style themselves are left exactly as the sender designed them.")}
      />

      <h2>{translate("Accent color")}</h2>
      <div className="swatches">
        {ACCENTS.map((a) => (
          <button key={a.id} className={`swatch ${s.accent === a.id ? "active" : ""}`} style={{ background: a.color }} onClick={() => update({ accent: a.id })} aria-label={a.id} title={a.id} />
        ))}
      </div>
      <h2>{translate("Density & text")}</h2>
      <div className="field-row">
        <div className="field">
          <label>{translate("Display density")}</label>
          <select disabled={isEnforced("density")} className="select" value={s.density} onChange={(e) => update({ density: e.target.value as typeof s.density })}>
            <option value="comfortable">{translate("Comfortable")}</option>
            <option value="cozy">{translate("Cozy (default)")}</option>
            <option value="compact">{translate("Compact")}</option>
          </select>
        </div>
        <div className="field">
          <label>{translate("Text size")}</label>
          <select disabled={isEnforced("fontSize")} className="select" value={s.fontSize} onChange={(e) => update({ fontSize: e.target.value as typeof s.fontSize })}>
            <option value="small">{translate("Small")}</option>
            <option value="medium">{translate("Medium")}</option>
            <option value="large">{translate("Large")}</option>
          </select>
        </div>
      </div>
      <h2>{translate("Language")}</h2>
      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="ui-language">{translate("Interface language")}</label>
        <select id="ui-language" className="select" value={s.uiLanguage} onChange={(e) => update({ uiLanguage: e.target.value })}>
          {UI_LANGUAGES.map((l) => (
            <option key={l.tag} value={l.tag}>{l.beta ? `${l.name} (Beta)` : l.name}</option>
          ))}
        </select>
      </div>
      {/*
        Said plainly rather than left to be discovered. A picker with one entry
        looks broken; a picker with one entry and a sentence explaining that
        more are coming is a roadmap.
      */}
      {/*
        Said plainly rather than buried. A machine translation presented as a
        finished one is the version of this that does harm: a reader told it was
        unchecked forgives an odd sentence and reports it, while a reader told
        it was reviewed reasonably concludes the product is sloppy. The report
        link is the entire review process, so it belongs one click from the
        thing being complained about.
      */}
      {betaChosen && (
        <p className="hint">
          {tNode("This translation was generated by AI and has not been checked by a native speaker, so it is marked Beta until somebody who speaks it signs it off. Anything that reads wrongly is worth reporting — {report}.", {
            report: <a href={`${TRANSLATION_ISSUE_URL}${encodeURIComponent(chosen?.name ?? "")}`} target="_blank" rel="noopener noreferrer">{translate("tell us about it")}</a>,
          })}
        </p>
      )}
      <p className="hint">
        {translate("Only languages ihasmail has been translated into appear here, so this list grows as translations land rather than ahead of them — a language offered without strings behind it would leave the page claiming to be in a language it is not.")}
      </p>
      <p className="hint">
        
        {tNode("This is separate from {setting} in General, which decides how dates, times and numbers are written. You can read an English interface with German dates, or the other way round.", { setting: <strong>{translate("Language & region")}</strong> })}
      </p>

      <h2>{translate("Swiping")}</h2>
      <p className="hint">
        
        {translate("On a touchscreen, drag a message sideways to act on it. Each direction can do one thing, or nothing. These follow your account, so a phone and a tablet agree; a mouse ignores them and keeps dragging messages into folders instead.")}
      </p>
      <div className="field-row">
        <div className="field">
          <label htmlFor="swipe-right">{translate("Swipe right")}</label>
          <select id="swipe-right" className="select" value={s.swipeRight} onChange={(e) => update({ swipeRight: e.target.value as SwipeAction })}>
            {SWIPE_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>{translate(c.label)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="swipe-left">{translate("Swipe left")}</label>
          <select id="swipe-left" className="select" value={s.swipeLeft} onChange={(e) => update({ swipeLeft: e.target.value as SwipeAction })}>
            {SWIPE_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>{translate(c.label)}</option>
            ))}
          </select>
        </div>
      </div>
      {/*
        Said once, where it is relevant, rather than greying the pickers out on
        a desktop: the settings are real and worth setting here for the phone
        that will read them, and a disabled control invites a hunt for whatever
        would enable it.
      */}
      {!isTouch && (
        <p className="hint">
          
          {translate("This screen has no touchscreen, so nothing here changes what it does. Your phone or tablet will pick these up.")}
        </p>
      )}
      <p className="hint">
        
        {translate("Holding a message selects it, and holding a folder opens its menu. Pull the top of the message list down to check for new mail.")}
      </p>

      <h2>{translate("Sidebar")}</h2>
      <Switch locked={isEnforced("labelsSidebar")} checked={s.labelsSidebar} onChange={(v) => update({ labelsSidebar: v })} label={translate("Show labels in the sidebar")} />
      <Switch locked={isEnforced("showHiddenFolders")} checked={s.showHiddenFolders} onChange={(v) => update({ showHiddenFolders: v })} label={translate("Show unsubscribed (hidden) folders")} />
      <Switch locked={isEnforced("sidebarCollapsed")} checked={s.sidebarCollapsed} onChange={(v) => update({ sidebarCollapsed: v })} label={translate("Collapse sidebar to icons")} />
    </div>
  );
}
