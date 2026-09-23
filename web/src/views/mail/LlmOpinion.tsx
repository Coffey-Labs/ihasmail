import { Bot } from "lucide-react";
import type { LlmOpinion } from "@/lib/llmOpinion";
import { t as translate } from "@/lib/i18n";

/*
 * The language model's opinion on a message, where the server's AI
 * spam classification recorded one (lib/llmOpinion).
 *
 * Two rules. It is always labeled as one signal the spam filter weighed among
 * several, never as the reason a message was filed where it was: the model's
 * category only adds the score the administrator gave its tag. And the
 * explanation is the model's own output, so it is only ever rendered as text.
 *
 * The category and confidence come from the server's configuration and aren't
 * translated; only the two framing strings are.
 */

function Verdict({ opinion }: { opinion: LlmOpinion }) {
  return (
    <>
      <strong>{opinion.category}</strong>
      {opinion.confidence && <span className="hint">{` · ${opinion.confidence}`}</span>}
    </>
  );
}

/** In the message details, beside the spam filter's own working. */
export function LlmOpinionDetail({ opinion }: { opinion: LlmOpinion }) {
  return (
    <div className="llm-opinion">
      <div>
        <Verdict opinion={opinion} />
      </div>
      {opinion.explanation && <div className="llm-explanation">{opinion.explanation}</div>}
      <div className="hint">{translate("One of several signals the spam filter weighed")}</div>
    </div>
  );
}

/** Above a message that's in Junk. */
export function LlmOpinionBanner({ opinion }: { opinion: LlmOpinion }) {
  return (
    <div className="remote-banner llm-banner" role="note" style={{ margin: "0 16px 8px" }}>
      <Bot size={16} />
      <span className="grow llm-opinion">
        <span className="llm-heading">
          <span>{translate("Language model's opinion")}</span>
          <span>
            <Verdict opinion={opinion} />
          </span>
        </span>
        {opinion.explanation && <span className="llm-explanation">{opinion.explanation}</span>}
        <span className="hint">{translate("One of several signals the spam filter weighed")}</span>
      </span>
    </div>
  );
}

/** The banner shows only for a message in Junk that carries an opinion. */
export function llmBannerOpinion(
  opinion: LlmOpinion | null,
  mailboxIds: Record<string, boolean>,
  junkId: string | null | undefined,
): LlmOpinion | null {
  return opinion && junkId && mailboxIds[junkId] ? opinion : null;
}
