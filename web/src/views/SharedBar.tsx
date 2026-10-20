import { Users } from "lucide-react";
import { useLocation } from "wouter";
import { useSession, useViewingShared } from "@/store/session";
import { t } from "@/lib/i18n";

/**
 * While a shared or group mailbox is in view, a bar across the whole app says
 * whose mail this is, with the way back. In the palette's accent, so it reads
 * as part of the app and not as a warning.
 */
export function SharedBar() {
  const shared = useViewingShared();
  const [, navigate] = useLocation();
  if (!shared) return null;
  const back = () => {
    useSession.getState().view(null);
    navigate("/mail");
  };
  return (
    <div className="shared-bar" role="status">
      <Users size={15} aria-hidden />
      <span className="grow truncate">
        {t("Shared mailbox:")} <strong className="notranslate" translate="no">{shared.name}</strong>
      </span>
      <button type="button" onClick={back}>
        {t("Back to my mail")}
      </button>
    </div>
  );
}
