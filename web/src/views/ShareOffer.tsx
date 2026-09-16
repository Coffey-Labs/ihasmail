import { shareSummary, type SharedContent } from "@/lib/shareTarget";
import { confirmDialog } from "@/ui/dialog";
import { t } from "@/lib/i18n";

/**
 * Ask before a share becomes a message.
 *
 * The share address takes a plain form POST, so any website can send one, and
 * the page cannot tell that from a share the reader made. Nothing would be
 * sent without them pressing Send, but a composer that appears full of
 * somebody else's text and files is still something to be asked about first.
 */
export async function offerShare(share: SharedContent, open: (share: SharedContent) => unknown): Promise<boolean> {
  const yes = await confirmDialog({
    title: t("Start a new message with what was shared?"),
    message: <ShareSummary share={share} />,
    confirmLabel: t("Start a message"),
    cancelLabel: t("Discard"),
  });
  if (yes) open(share);
  return yes;
}

/** What arrived, so the reader can tell whether it is theirs. */
function ShareSummary({ share }: { share: SharedContent }) {
  const { title, preview, files } = shareSummary(share);
  return (
    <div>
      {(title || preview) && (
        <blockquote className="share-summary notranslate" translate="no">
          {title && <strong>{title}</strong>}
          {title && preview && <br />}
          {preview}
        </blockquote>
      )}
      {files.length > 0 && (
        <ul className="share-summary-files notranslate" translate="no">
          {files.slice(0, 5).map((name, i) => <li key={`${name}-${i}`}>{name}</li>)}
          {files.length > 5 && <li>…</li>}
        </ul>
      )}
      <p>{t("Something was shared with ihasmail. Nothing is sent until you choose Send. If you didn't just share this, discard it.")}</p>
    </div>
  );
}
