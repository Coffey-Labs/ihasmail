import { useMemo } from "react";
import qrcode from "qrcode-generator";
import { t } from "@/lib/i18n";

/**
 * A QR code as inline SVG.
 *
 * Drawn as one path of square modules so it scales cleanly and inherits the
 * current colour, which keeps it legible in both themes without a second
 * rendering path. Error correction is set to M: enough tolerance for a phone
 * camera pointed at a screen, without inflating the module count.
 */
export function QrCode({ value, size = 200, title }: { value: string; size?: number; title?: string }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let path = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { path, count };
  }, [value]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`-2 -2 ${count + 4} ${count + 4}`}
      role="img"
      aria-label={title ?? t("QR code")}
      shapeRendering="crispEdges"
      style={{ background: "#fff", borderRadius: 8, display: "block" }}
    >
      <title>{title ?? "QR code"}</title>
      <path d={path} fill="#000" />
    </svg>
  );
}
