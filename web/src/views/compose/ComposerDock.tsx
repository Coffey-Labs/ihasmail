import { useCompose } from "@/store/compose";
import { Composer } from "./Composer";
import { useIsMobile } from "@/ui/misc";

export function ComposerDock() {
  const drafts = useCompose((s) => s.drafts);
  const activeKey = useCompose((s) => s.activeKey);
  const isMobile = useIsMobile();
  if (!drafts.length) return null;
  // On mobile only the active composer is shown (full screen); others are minimized bars.
  const visible = isMobile ? drafts.filter((d) => d.key === activeKey || d.minimized) : drafts;
  return (
    <div className="composer-dock">
      {visible.map((d) => (
        <Composer key={d.key} draft={isMobile && d.key !== activeKey ? { ...d, minimized: true } : d} />
      ))}
    </div>
  );
}
