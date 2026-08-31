import { useSettings } from "@/store/settings";
import { Switch, useIsTouch } from "@/ui/misc";
import { SWIPE_CHOICES, type SwipeAction } from "@/lib/swipe";
import { UI_LANGUAGES } from "@/lib/languages";
import { t as translate } from "@/lib/i18n";

/**
 * The theme cards, each previewing the background it actually paints. Kept as
 * data rather than three inline ternaries so a fourth does not mean editing a
 * conditional in three places.
 */
const THEMES = [
  { id: "system", label: "Match system", preview: "linear-gradient(90deg,#f6f8fa 50%,#0b1220 50%)" },
  { id: "light", label: "Light", preview: "#f6f8fa" },
  { id: "dark", label: "Dark", preview: "#0b1220" },
  // The ihasmail.org palette: its background, with its teal and the logo's
  // orange showing, so the card looks like what picking it does.
  { id: "ihasmail", label: "ihasmail", preview: "linear-gradient(135deg,#0d2430 0%,#12303e 55%,#46cac3 55%,#46cac3 78%,#f9a34b 78%)" },
] as const;

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
  const isTouch = useIsTouch();
  return (
    <div>
      <h1>{translate("Appearance")}</h1>
      <p className="lead">{translate("Make ihasmail yours.")}</p>
      <h2>{translate("Theme")}</h2>
      <div className="theme-grid">
        {THEMES.map((t) => (
          <button key={t.id} className={`theme-card ${s.theme === t.id ? "active" : ""}`} onClick={() => update({ theme: t.id })}>
            <div className="preview" style={{ background: t.preview }} />
            {t.label}
          </button>
        ))}
      </div>
      <p className="hint" style={{ marginTop: 10 }}>
        <strong>{translate("ihasmail")}</strong>  {translate("is the palette from")} <a href="https://ihasmail.org" target="_blank" rel="noopener noreferrer">{translate("ihasmail.org")}</a>{translate(", and what a new account starts on. It is a dark theme, so it counts as dark wherever that matters, and the accent colour below still applies on top of it.")}
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
          <select className="select" value={s.density} onChange={(e) => update({ density: e.target.value as typeof s.density })}>
            <option value="comfortable">{translate("Comfortable")}</option>
            <option value="cozy">{translate("Cozy (default)")}</option>
            <option value="compact">{translate("Compact")}</option>
          </select>
        </div>
        <div className="field">
          <label>{translate("Text size")}</label>
          <select className="select" value={s.fontSize} onChange={(e) => update({ fontSize: e.target.value as typeof s.fontSize })}>
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
            <option key={l.tag} value={l.tag}>{l.name}</option>
          ))}
        </select>
      </div>
      {/*
        Said plainly rather than left to be discovered. A picker with one entry
        looks broken; a picker with one entry and a sentence explaining that
        more are coming is a roadmap.
      */}
      <p className="hint">
        
        {translate("Only languages ihasmail has been translated into appear here, so this list grows as translations land rather than ahead of them — a language offered without strings behind it would leave the page claiming to be in a language it is not.")}
      </p>
      <p className="hint">
        
        {translate("This is separate from")} <strong>{translate("Language & region")}</strong>  {translate("in General, which decides how dates, times and numbers are written. You can read an English interface with German dates, or the other way round.")}
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
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="swipe-left">{translate("Swipe left")}</label>
          <select id="swipe-left" className="select" value={s.swipeLeft} onChange={(e) => update({ swipeLeft: e.target.value as SwipeAction })}>
            {SWIPE_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
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
      <Switch checked={s.labelsSidebar} onChange={(v) => update({ labelsSidebar: v })} label={translate("Show labels in the sidebar")} />
      <Switch checked={s.showHiddenFolders} onChange={(v) => update({ showHiddenFolders: v })} label={translate("Show unsubscribed (hidden) folders")} />
      <Switch checked={s.sidebarCollapsed} onChange={(v) => update({ sidebarCollapsed: v })} label={translate("Collapse sidebar to icons")} />
    </div>
  );
}
