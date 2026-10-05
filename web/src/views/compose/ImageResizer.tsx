import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { t as translate } from "@/lib/i18n";

/*
 * Resizing an image in the composer (Gitea issue #26).
 *
 * An inserted image went in at its own size, capped at the editor's width,
 * and nothing could change it. A screenshot pasted from a large monitor
 * filled the message. Click an image and this puts a frame round it, with a
 * handle in the corner to drag it to any width, and three fixed sizes plus
 * Original size above it.
 *
 * The frame is drawn over the editor rather than inside it, so none of it
 * ends up in the message. The only thing that changes in the message is the
 * image's own width: as a `width` attribute, which Outlook needs because it
 * ignores CSS on images, and as an inline style, which everything else
 * reads. `max-width:100%` stays, so a large image still shrinks to fit a
 * phone on the receiving end.
 */

/** Fixed widths, in CSS pixels, as offered in the report. */
export const IMAGE_SIZE_PRESETS: ReadonlyArray<{ label: string; width: number }> = [
  { label: "Small", width: 300 },
  { label: "Medium", width: 600 },
  { label: "Large", width: 900 },
];

const MIN_WIDTH = 24;

/** Set an image's width, or clear it with `null` to go back to its own size. */
export function setImageWidth(img: HTMLImageElement, width: number | null): void {
  // A height would fight the new width and stretch the image.
  img.removeAttribute("height");
  img.style.height = "auto";
  img.style.maxWidth = "100%";
  if (width === null) {
    img.removeAttribute("width");
    img.style.width = "";
    return;
  }
  const w = Math.max(MIN_WIDTH, Math.round(width));
  img.setAttribute("width", String(w));
  img.style.width = `${w}px`;
}

/** The width the image has been given, or null when it is at its own size. */
export function imageWidth(img: HTMLImageElement): number | null {
  const w = Number.parseInt(img.getAttribute("width") ?? "", 10);
  return Number.isFinite(w) && w > 0 ? w : null;
}

interface Box {
  /** Where the editor area sits inside the composer, which is what the layer is positioned against. */
  areaTop: number;
  areaLeft: number;
  areaWidth: number;
  areaHeight: number;
  /** The image, relative to the editor area's visible box. */
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Props {
  /** The editable area. Its parent must be positioned, as `.composer-editor` is. */
  area: HTMLDivElement;
  img: HTMLImageElement;
  /** Called once a change is finished, to save the draft. */
  onChange: () => void;
  onClose: () => void;
}

export function ImageResizer({ area, img, onChange, onClose }: Props) {
  const [box, setBox] = useState<Box | null>(null);
  const [width, setWidth] = useState<number | null>(() => imageWidth(img));
  const layerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; max: number } | null>(null);

  const measure = useCallback(() => {
    const a = area.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    setBox({
      areaTop: area.offsetTop, areaLeft: area.offsetLeft, areaWidth: a.width, areaHeight: a.height,
      top: r.top - a.top, left: r.left - a.left, width: r.width, height: r.height,
    });
  }, [area, img]);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(img);
    ro.observe(area);
    area.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      area.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [area, img, measure]);

  // Anything but the image or the frame lets it go, and so does Escape.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (target === img || layerRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [img, onClose]);

  const apply = (w: number | null) => {
    setImageWidth(img, w);
    setWidth(imageWidth(img));
    measure();
    onChange();
  };

  const onHandleDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const style = getComputedStyle(area);
    const max = area.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    drag.current = { x: e.clientX, width: img.getBoundingClientRect().width, max };
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d) return;
    const w = Math.min(d.max, Math.max(MIN_WIDTH, d.width + (e.clientX - d.x)));
    setImageWidth(img, w);
    measure();
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setWidth(imageWidth(img));
    onChange();
  };

  if (!box) return null;
  // The size bar sits above the image, or inside its top edge when the image
  // starts at the top of what is visible.
  const barTop = Math.max(4, box.top - 34);
  return (
    <div
      ref={layerRef}
      className="img-resize-layer"
      style={{ top: box.areaTop, left: box.areaLeft, width: box.areaWidth, height: box.areaHeight }}
    >
      <div className="img-resize-frame" style={{ top: box.top, left: box.left, width: box.width, height: box.height }}>
        <span
          className="img-resize-handle"
          role="slider"
          aria-label={translate("Drag to resize")}
          aria-valuenow={Math.round(box.width)}
          aria-valuemin={MIN_WIDTH}
          title={translate("Drag to resize")}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
        />
      </div>
      <div className="img-resize-bar" role="toolbar" aria-label={translate("Image size")} style={{ top: barTop, left: Math.max(4, box.left) }}>
        {IMAGE_SIZE_PRESETS.map((p) => (
          <button
            key={p.width}
            type="button"
            className="btn btn-sm"
            aria-pressed={width === p.width}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => apply(p.width)}
          >
            {translate(p.label)}
          </button>
        ))}
        <button type="button" className="btn btn-sm" aria-pressed={width === null} onMouseDown={(e) => e.preventDefault()} onClick={() => apply(null)}>
          {translate("Original size")}
        </button>
      </div>
    </div>
  );
}
