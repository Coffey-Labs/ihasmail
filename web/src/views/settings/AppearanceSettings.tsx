import { useSettings } from "@/store/settings";
import { Switch } from "@/ui/misc";

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
  return (
    <div>
      <h1>Appearance</h1>
      <p className="lead">Make ihasmail yours.</p>
      <h2>Theme</h2>
      <div className="theme-grid">
        {(["system", "light", "dark"] as const).map((t) => (
          <button key={t} className={`theme-card ${s.theme === t ? "active" : ""}`} onClick={() => update({ theme: t })}>
            <div className="preview" style={{ background: t === "dark" ? "#0b1220" : t === "light" ? "#f6f8fa" : "linear-gradient(90deg,#f6f8fa 50%,#0b1220 50%)" }} />
            {t === "system" ? "Match system" : t === "light" ? "Light" : "Dark"}
          </button>
        ))}
      </div>
      <h2>Accent color</h2>
      <div className="swatches">
        {ACCENTS.map((a) => (
          <button key={a.id} className={`swatch ${s.accent === a.id ? "active" : ""}`} style={{ background: a.color }} onClick={() => update({ accent: a.id })} aria-label={a.id} title={a.id} />
        ))}
      </div>
      <h2>Density & text</h2>
      <div className="field-row">
        <div className="field">
          <label>Display density</label>
          <select className="select" value={s.density} onChange={(e) => update({ density: e.target.value as typeof s.density })}>
            <option value="comfortable">Comfortable</option>
            <option value="cozy">Cozy (default)</option>
            <option value="compact">Compact</option>
          </select>
        </div>
        <div className="field">
          <label>Text size</label>
          <select className="select" value={s.fontSize} onChange={(e) => update({ fontSize: e.target.value as typeof s.fontSize })}>
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </div>
      </div>
      <h2>Sidebar</h2>
      <Switch checked={s.labelsSidebar} onChange={(v) => update({ labelsSidebar: v })} label="Show labels in the sidebar" />
      <Switch checked={s.showHiddenFolders} onChange={(v) => update({ showHiddenFolders: v })} label="Show unsubscribed (hidden) folders" />
      <Switch checked={s.sidebarCollapsed} onChange={(v) => update({ sidebarCollapsed: v })} label="Collapse sidebar to icons" />
    </div>
  );
}
