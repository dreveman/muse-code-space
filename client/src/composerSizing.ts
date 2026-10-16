// Grow either message textarea with its content, then scroll inside it once
// it reaches a comfortable reading height. Reset to auto before measuring so
// deleting text also shrinks a previously expanded composer.
export const COMPOSER_MAX_HEIGHT = 240;
export const COMPOSER_MIN_HEIGHT = 48;

export const COMPOSER_TOOLBAR_HEIGHT = 47;

export function resizeComposerTextarea(
  input: Pick<HTMLTextAreaElement, "style" | "scrollHeight"> & { parentElement?: HTMLElement | null },
): void {
  const previousHeight = input.style.height || `${COMPOSER_MIN_HEIGHT}px`;
  input.style.height = "auto";
  const contentHeight = input.scrollHeight;
  const clampedHeight = Math.max(COMPOSER_MIN_HEIGHT, Math.min(contentHeight, COMPOSER_MAX_HEIGHT));
  const nextHeight = `${clampedHeight}px`;
  input.style.height = nextHeight;
  input.style.overflowY = contentHeight > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
  if (nextHeight !== previousHeight) {
    input.parentElement?.style.setProperty("height", `${clampedHeight + COMPOSER_TOOLBAR_HEIGHT}px`);
  }
}
