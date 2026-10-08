import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

type Props = {
  label: string;
  controls: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange: (value: number) => void;
  valueFromPointer: (clientX: number) => number;
};

/** A one-pixel rule with a larger invisible pointer target; keyboard users can
 * use arrows (or Home/End), and double-click restores the default width. */
export function PaneDivider({ label, controls, value, min, max, defaultValue, onChange, valueFromPointer }: Props) {
  const activePointer = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const resize = (next: number) => onChange(Math.max(min, Math.min(max, next)));

  const stop = (event: PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== event.pointerId) return;
    activePointer.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 16;
    let next: number;
    switch (event.key) {
      case "ArrowLeft": next = value - step; break;
      case "ArrowRight": next = value + step; break;
      case "Home": next = min; break;
      case "End": next = max; break;
      default: return;
    }
    event.preventDefault();
    resize(next);
  };

  return (
    <div
      className={`pane-divider${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuetext={`${Math.round(value)} pixels`}
      tabIndex={0}
      title={`${label} — drag or use arrow keys; double-click to reset`}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.isPrimary === false) return;
        event.preventDefault();
        activePointer.current = event.pointerId;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDragging(true);
        resize(valueFromPointer(event.clientX));
      }}
      onPointerMove={(event) => {
        if (activePointer.current === event.pointerId) resize(valueFromPointer(event.clientX));
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={() => { activePointer.current = null; setDragging(false); }}
      onKeyDown={onKeyDown}
      onDoubleClick={() => resize(defaultValue)}
    />
  );
}
