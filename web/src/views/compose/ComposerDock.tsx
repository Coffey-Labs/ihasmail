import { lazy, Suspense } from "react";
import { useCompose } from "@/store/compose";
import { useIsMobile } from "@/ui/misc";

/*
 * The composer -- the rich-text editor, the recipient and file pickers -- is
 * loaded apart from the mail view, and fetched while the browser is idle
 * after startup so the first Compose does not wait on the network.
 */
const loadComposer = () => import("./Composer");
const Composer = lazy(() => loadComposer().then((m) => ({ default: m.Composer })));
if (typeof window !== "undefined") {
  const warm = () => void loadComposer().catch(() => {});
  if ("requestIdleCallback" in window) window.requestIdleCallback(warm, { timeout: 5000 });
  else setTimeout(warm, 2000);
}

export function ComposerDock() {
  const drafts = useCompose((s) => s.drafts);
  const activeKey = useCompose((s) => s.activeKey);
  const isMobile = useIsMobile();
  if (!drafts.length) return null;
  // On mobile only the active composer is shown (full screen); others are minimized bars.
  const visible = isMobile ? drafts.filter((d) => d.key === activeKey || d.minimized) : drafts;
  // On desktop a full-screen composer stands alone: the rest are hidden until it is restored.
  const hasMaximized = !isMobile && drafts.some((d) => d.maximized && !d.minimized);
  return (
    <div className={`composer-dock${hasMaximized ? " has-maximized" : ""}`}>
      <Suspense fallback={null}>
        {visible.map((d) => (
          <Composer key={d.key} draft={isMobile && d.key !== activeKey ? { ...d, minimized: true } : d} />
        ))}
      </Suspense>
    </div>
  );
}
