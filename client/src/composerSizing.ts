// Grow either message textarea with its content, then scroll inside it once
// it reaches a comfortable reading height. Reset to auto before measuring so
// deleting text also shrinks a previously expanded composer.
export const COMPOSER_MAX_HEIGHT = 240;
export const COMPOSER_MIN_HEIGHT = 48;

export function resizeComposerTextarea(input: Pick<HTMLTextAreaElement, "style" | "scrollHeight">): void {
  input.style.height = "auto";
  const contentHeight = input.scrollHeight;
  input.style.height = `${Math.max(COMPOSER_MIN_HEIGHT, Math.min(contentHeight, COMPOSER_MAX_HEIGHT))}px`;
  input.style.overflowY = contentHeight > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
}
