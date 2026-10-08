import { useLayoutEffect, useRef, type RefObject } from "react";
import type { MentionAgent } from "./agentMentions";
import { displayAgentName } from "./agentColor";
import { companionForName } from "./companionRoster";
import { companionArtwork } from "./companionArtwork";

export function AgentMentionMenu({ agents, activeIndex, onChoose, inputRef, mentionStart, value }: {
  agents: readonly MentionAgent[];
  activeIndex: number;
  onChoose: (agent: MentionAgent) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  mentionStart: number;
  value: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const input = inputRef.current;
    const menu = menuRef.current;
    const parent = menu?.offsetParent;
    if (!input || !menu || !(parent instanceof HTMLElement)) return;
    const position = () => {
      // Mirror textarea wrapping to locate the @ token, including scrolled text.
      const mirror = document.createElement("div");
      const computed = getComputedStyle(input);
      for (const property of Array.from(computed)) mirror.style.setProperty(property, computed.getPropertyValue(property));
      Object.assign(mirror.style, {
        position: "fixed", left: "0", top: "0", visibility: "hidden",
        width: `${input.getBoundingClientRect().width}px`, height: "auto",
        minHeight: "0", maxHeight: "none", overflow: "visible", whiteSpace: "pre-wrap",
      });
      mirror.textContent = input.value.slice(0, mentionStart);
      const marker = document.createElement("span");
      marker.textContent = "@";
      mirror.append(marker, document.createTextNode(input.value.slice(mentionStart + 1)));
      document.body.append(mirror);
      const markerRect = marker.getBoundingClientRect();
      const mirrorRect = mirror.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      const anchorX = inputRect.left + markerRect.left - mirrorRect.left - input.scrollLeft;
      const anchorY = inputRect.top + markerRect.top - mirrorRect.top - input.scrollTop;
      const lineHeight = markerRect.height;
      mirror.remove();
      const originX = parentRect.left + parent.clientLeft;
      const originY = parentRect.top + parent.clientTop;
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      let top = anchorY - menu.offsetHeight - 6;
      if (top < viewportTop + 8) top = anchorY + lineHeight + 6;
      top = Math.max(viewportTop + 8, Math.min(top, viewportBottom - menu.offsetHeight - 8));
      menu.style.left = `${Math.max(8, Math.min(anchorX - originX, parent.clientWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${top - originY}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(input);
    observer.observe(menu);
    observer.observe(parent);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [inputRef, mentionStart, value]);
  const chosenRef = useRef(false);
  const chooseOnce = (agent: MentionAgent) => {
    if (chosenRef.current) return; // pointerdown may be followed by click
    chosenRef.current = true;
    onChoose(agent);
  };
  return (
    <div ref={menuRef} className="agent-mention-menu" id="agent-mention-options" role="listbox" aria-label="Mention a companion">
      {agents.length === 0 ? (
        <div className="agent-mention-empty">No matching companions</div>
      ) : agents.map((agent, index) => {
        const artwork = !agent.assistant && companionArtwork[companionForName(agent.name)?.id ?? ""];
        return (
          <button
            type="button"
            role="option"
            id={`agent-mention-option-${index}`}
            aria-selected={index === activeIndex}
            key={agent.session_id}
            className={`agent-mention-option${index === activeIndex ? " active" : ""}`}
            onPointerDown={(event) => { event.preventDefault(); chooseOnce(agent); }}
            onClick={() => chooseOnce(agent)}
          >
            <span className="agent-mention-name">
              {artwork && <img className="agent-mention-icon" src={artwork.still} width={22} height={22} alt="" />}
              <span>@{displayAgentName(agent.name)}{agent.assistant && <span className="agent-mention-role"> (your Muse assistant)</span>}</span>
            </span>
            {!agent.assistant && agent.busy && <span className="agent-mention-presence">working</span>}
          </button>
        );
      })}
    </div>
  );
}
