/**
 * Checking the signature on the message being read.
 *
 * Two things this is careful about, both about not doing work:
 *
 *   - The verifier is imported dynamically. Signed mail is rare, and DER
 *     parsing plus certificate reading has no business in the bundle everybody
 *     downloads to read an unsigned message.
 *   - Nothing is fetched unless the message says it is signed. The structure
 *     already came with the message, so the common answer costs one string
 *     comparison and no network at all.
 */
import { useEffect, useState } from "react";
import { client } from "@/jmap/client";
import type { Email, EmailBodyPart, Id } from "@/jmap/types";
import { useSettings, type SignerPin } from "@/store/settings";
import type { SignatureReport } from "./verify";

/**
 * How many signers are remembered before the oldest pin is dropped.
 *
 * A cap is needed because this rides in the account's settings file, which is
 * fetched on every sign-in. Evicting is not free — a dropped signer is greeted
 * as new next time, which is a quieter message than it should be — so the limit
 * is set far above what S/MIME's actual prevalence will produce rather than at
 * a number that trades safety for bytes.
 */
const MAX_PINS = 500;

export type SignatureState = { status: "idle" } | { status: "checking" } | { status: "done"; report: SignatureReport };

/** Whether anything in this message's structure claims to be signed. */
export function structureLooksSigned(part: EmailBodyPart | undefined): boolean {
  if (!part) return false;
  if (part.type === "multipart/signed") return true;
  return (part.subParts ?? []).some(structureLooksSigned);
}

export function useSignature(email: Email | undefined, accountId: Id | null): SignatureState {
  const [state, setState] = useState<SignatureState>({ status: "idle" });

  useEffect(() => {
    if (!email || !accountId || !structureLooksSigned(email.bodyStructure)) {
      setState({ status: "idle" });
      return;
    }
    let live = true;
    setState({ status: "checking" });

    void (async () => {
      try {
        const [{ judge, shouldRemember, verifyMessage }, blob] = await Promise.all([
          import("./verify"),
          client.fetchBlob(accountId, email.blobId, "message/rfc822"),
        ]);
        if (!live) return;

        const raw = new Uint8Array(await blob.arrayBuffer());
        const from = (email.from?.[0]?.email ?? "").toLowerCase();
        const crypto = await verifyMessage(raw);
        const stored = useSettings.getState().settings.knownSigners[from];
        // A pin this very message created is not corroboration of it. Treated
        // as absent, so the message that established a signer keeps saying so
        // however many times it is reopened.
        const known = stored && stored.messageId === email.id ? undefined : stored;
        const report = judge(crypto, from, known);
        if (!live) return;

        if (from && shouldRemember(report) && report.crypto.kind === "intact") {
          pin(from, {
            fingerprint: report.crypto.cert.fingerprint,
            name: report.crypto.cert.subject.commonName || report.crypto.cert.subject.emailAddress || from,
            firstSeen: new Date().toISOString(),
            messageId: email.id,
          });
        }
        setState({ status: "done", report });
      } catch (err) {
        if (!live) return;
        // A failure to *look* is not a failure to verify, and must not be shown
        // as one: a dropped connection is not a bad signature.
        setState({ status: "done", report: { crypto: { kind: "unsupported", reason: "other", detail: (err as Error).message }, warnings: [] } });
      }
    })();

    return () => {
      live = false;
    };
  }, [email, accountId]);

  return state;
}

function pin(address: string, entry: SignerPin): void {
  const { settings, update } = useSettings.getState();
  const next = { ...settings.knownSigners, [address]: entry };
  const keys = Object.keys(next);
  if (keys.length > MAX_PINS) {
    const oldest = keys.sort((a, b) => (next[a]!.firstSeen < next[b]!.firstSeen ? -1 : 1)).slice(0, keys.length - MAX_PINS);
    for (const k of oldest) delete next[k];
  }
  update({ knownSigners: next });
}
