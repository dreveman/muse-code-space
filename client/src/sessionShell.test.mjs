// Regression tests for the app shell: no front page, "Code Companions" sidebar
// header, hover-only row actions, and the same actions in the session menu
// for touch devices.
// Run: node --test client/src/sessionShell.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(root, "App.tsx"), "utf8");
const menu = readFileSync(path.join(root, "WireDebug.tsx"), "utf8");
const css = readFileSync(path.join(root, "theme.css"), "utf8");

test("zero tasks show a companion card with a first-message composer", () => {
  assert.ok(app.includes('if (sessions.length === 0 && draft === null)'));
  assert.ok(app.includes('selectCompanion("pip", false)'));
  assert.ok(app.includes('<CompanionWelcome companion={selectedCompanion}'));
  assert.ok(!app.includes('autoDraftedRef'), "opening the app does not silently prepare a new task");
});

test("sidebar header says Code Companions without a create button", () => {
  const header = app.match(/<header className="command-bar">[\s\S]*?<\/header>/);
  assert.ok(header, "command-bar header must always render");
  assert.ok(header[0].includes("<h1>Code Companions</h1>"));
  assert.ok(!header[0].includes('<button'), "tasks start by messaging a companion");
  assert.ok(!app.includes("active session{"), "the active-session count headline is gone");
});

test("row rename/archive buttons are hover-only and hidden on touch", () => {
  assert.ok(app.includes('<div className="session-row-actions">'), "row actions share a container");
  const base = css.match(/\.session-row-actions\s*\{[^}]*\}/);
  assert.ok(base && /display:\s*none/.test(base[0]), "hidden by default");
  assert.ok(/\.session-row:hover \.session-row-actions/.test(css), "shown on hover");
  assert.ok(/\.session-row:focus-within \.session-row-actions/.test(css), "shown for keyboard focus");
  assert.ok(/@media \(hover: hover\) and \(pointer: fine\)\s*\{[^}]*\.session-row:hover \.session-row-actions/.test(css),
    "revealed only where hover is primary — a touch tap must navigate on first press, not reveal actions");
});

test("hamburger menu remains available on cards, during startup, with no agent, and in chats", () => {
  assert.equal((app.match(/<SessionMenu\b/g) ?? []).length, 4);
  assert.ok(app.includes('!draftSelected && (selectedId === null || !detailSession || detailQuery.isPending || !sessionsQuery.data || sessions.length === 0)'), "empty/loading detail keeps the menu");
  assert.ok(app.includes('className="chat-floating-actions"'), "empty detail keeps floating menu controls");
  assert.ok(app.includes('actions={sessionMenuActions(selectedSession ?? detailSession)}'), "real agents retain session actions");
});

test("session menu offers summary editing and archive/restore", () => {
  assert.ok(app.includes("actions={sessionMenuActions(selectedSession ?? detailSession)}"), "menu reads the freshly refetched list copy");
  for (const label of ['"Change task summary"', '"Archive task"', '"Restore task"']) {
    assert.ok(app.includes(label), `menu action ${label}`);
  }
  assert.ok(/disabled: live \|\| archiveBusy/.test(app), "running sessions can't be archived from the menu either");
  assert.ok(menu.includes('action.checked === undefined ? "menuitem" : "menuitemcheckbox"') && menu.includes("actions.map"), "menu renders actions and checkbox toggles");
  assert.ok(menu.includes('label={panelVisible ? "Hide wire log" : "Show wire log"}'), "wire log toggle stays");
});

test("filters read Active / Past as a compact toggle", () => {
  assert.ok(app.includes('{ value: "inactive", label: "Past" }'));
  assert.ok(!app.includes('label: "Inactive"'));
  const bar = css.match(/\.filter-bar\s*\{[^}]*\}/);
  assert.ok(bar && /display:\s*inline-flex/.test(bar[0]) && /border-radius:\s*6px/.test(bar[0]), "segmented, rounded like the model button");
  const btn = css.match(/\.filter-bar button\s*\{[^}]*\}/);
  assert.ok(btn && /var\(--mono\)/.test(btn[0]) && /10px/.test(btn[0]), "mono 10px like the model button");
});

test("desktop layout is edge to edge so the dividers meet", () => {
  const desktop = css.slice(css.indexOf("@media (min-width: 780px)"));
  assert.ok(/\.workspace\s*\{[^}]*padding:\s*0;/.test(desktop), "no page padding");
  assert.ok(/\.console-layout\s*\{[^}]*gap:\s*0;/.test(desktop), "no gap between rail and transcript");
  assert.ok(/\.pane-divider\s*\{[^}]*display:\s*block/.test(desktop), "a full-height one-pixel resize divider replaces the rail border");
});

test("only unseen output makes agent names bold", () => {
  assert.ok(/\.session-title\s*\{[^}]*font:\s*400 12px/.test(css), "read agents are normal weight");
  assert.ok(/\.session-row\.unread \.session-title\s*\{[^}]*font-weight:\s*700/.test(css), "unseen output makes the name bold");
});

test("expanded groups draw a guide line under the chevron", () => {
  const list = css.match(/\.session-group-list\s*\{[^}]*\}/);
  assert.ok(list && /border-left:\s*1px solid/.test(list[0]));
  assert.ok(/\.session-group-header\[aria-expanded="true"\] \.session-group-chevron svg\s*\{[^}]*rotate\(90deg\)/.test(css), "chevron turns down when expanded");
  assert.ok(app.includes("<ChevronIcon />") && !app.includes('"⌄"'), "SVG chevron replaces the ⌄/› glyphs");
});

test("No Project header has no count and no +", () => {
  assert.ok(app.includes('{group.key !== "" && <span className="session-group-count">'));
  assert.ok(!app.includes('className="session-group-add"'), "no explicit task creation controls");
});

test("connection loss keeps the UI up with status in the companion bubble", () => {
  assert.ok(!app.includes('className="error-state"'), "no separate error page");
  assert.ok(!app.includes("Sessions couldn’t load."));
  assert.ok(app.includes('connecting={connectionLost || pilotUnavailable}'));
  assert.ok(/detailQuery\.isError && !detail \?/.test(app), "a failed refetch keeps the loaded transcript");
});

test("one prompt can be queued while disconnected and is sent on reconnect", () => {
  assert.ok(app.includes("const promptConnectionLost = connectionLost || pilotUnavailable;"), "pilot outages also queue prompts");
  assert.equal((app.match(/decideSubmit\(promptConnectionLost, queuedPrompt !== null\)/g) ?? []).length, 2);
  assert.ok(/if \(connectionLost \|\| queuedPilotUnavailable \|\| queuedPrompt === null \|\| flushingRef\.current\) return;/.test(app), "waits for both app and target pilot session");
  assert.ok(app.includes("<QueuedEcho"), "queued prompt is shown in the transcript");
  assert.ok(app.includes("setDirection((current) => current || content)"), "a failed send puts the text back");
  assert.ok(app.includes("if (queuedMessageHere === null && queuedDraftHere === null) return;"), "only a visible queued prompt triggers the scroll");
  assert.ok(/queuedMessageHere, queuedDraftHere, detailSession\?\.id, draft\?\.id/.test(app), "scrolls on queue/selection, not every polling update");
  assert.ok(app.includes('className="terminal-prompt companion-first-prompt"') && app.includes('<QueuedEcho text={queuedPrompt.prompt}'), "queued first prompts stay visible below the card");
  const working = app.indexOf('{sessionActive && pendingEcho === null && !pilotUnavailable && <WorkingIndicator label={workingLabel}');
  assert.ok(working !== -1 && working < app.indexOf('<QueuedEcho text={queuedMessageHere}'), "queued prompt is last when an agent is working");
  assert.ok(/\.queued-note\s*\{[^}]*padding:\s*4px 20px 10px/.test(css), "Cancel row has breathing room above it");
});

test("sidebar rows: blank at rest, button-like hover, agent-name-colored selection", () => {
  const rule = (sel) => css.match(new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*\\}`, "m"))?.[0] ?? "";
  assert.ok(/background:\s*transparent/.test(rule(".session-row")), "blank when idle");
  assert.ok(/border-radius:\s*6px/.test(rule(".session-row")), "button-like corners");
  assert.ok(/background:\s*var\(--row-bg\)/.test(rule(".session-row:hover")), "fills on hover");
  const selected = rule(".session-row.selected");
  assert.ok(/--agent-hue/.test(selected) && /box-shadow:\s*inset 0 0 0 1px/.test(selected), "selected: name hue fill + matching border");
  assert.ok(app.includes('className={`session-row${selected ? " selected" : ""}${summary ? " has-summary" : ""}${visual === "unread" ? " unread" : ""}`} style={agentColorStyle(session.title)}'));
  assert.ok(/background:\s*var\(--row-bg\)/.test(rule(".session-row-actions")), "hover actions match the row fill");
  assert.ok(/background:\s*color-mix/.test(rule(".session-group-header:hover")), "project headers get the hover fill too");
});

test("Past list groups by age; rows offer delete only", () => {
  assert.ok(app.includes('groupSessionsByAge(visibleSessions, nowMs)') && app.includes('groupSessionsByProject(visibleSessions, projects)'), "existing age/project groups remain");
  assert.ok(app.includes('sortSessions(group.sessions, sortMode)'), "the selected mode orders agents within each group");
  assert.ok(app.includes('past={filter === "inactive"}'));
  const row = app.slice(app.indexOf("function SessionRow("), app.indexOf("export function App()"));
  const pastBranch = row.slice(row.indexOf("{past ? ("), row.indexOf(") : (", row.indexOf("{past ? (")));
  assert.ok(pastBranch.includes("<TrashIcon />") && !pastBranch.includes("<PencilIcon />"), "past rows: delete, no rename");
  assert.ok(app.includes("api.deleteSession({ id: sessionId })"));
  assert.ok(app.includes('"Delete task"') && app.includes("onActivate: () => askToDelete(session)"), "menu delete goes through the confirmation dialog");
});

test("projects automatically group active tasks without a toggle or sidebar create button", () => {
  assert.ok(app.includes('projects.length > 0 ? groupSessionsByProject(visibleSessions, projects)'));
  assert.ok(!app.includes('Group tasks by project'));
  assert.ok(!app.includes('session-new-project'));
});

test("filter box: compact shape, quiet fill, accent border while editing", () => {
  const rule = css.match(/^\.session-filter\s*\{[^}]*\}/m)?.[0] ?? "";
  assert.ok(/border-radius:\s*6px/.test(rule) && /min-height:\s*32px/.test(rule), "button shape");
  assert.ok(/background:\s*color-mix\(in srgb, var\(--text\) 4%, transparent\)/.test(rule), "always a light fill");
  assert.ok(/\.session-filter input:focus, \.session-filter input:focus-visible\s*\{[^}]*outline:\s*none/.test(css), "no second focus ring inside the accent border");
  assert.ok(/\.session-filter:focus-within\s*\{[^}]*inset 0 0 0 1px var\(--accent\)/.test(css), "accent border while editing");
  assert.ok(/\.session-filter input\s*\{[^}]*font:\s*600 12px var\(--sans\)/.test(css), "same text style as the button");
});

test("archive is one click; delete always goes through a permanent-delete dialog", () => {
  assert.ok(!app.includes("confirmArchiveId") && !app.includes("confirmDeleteId"), "no two-click arming left");
  assert.ok(!app.includes("window.confirm("), "no native confirm (can be blocked in the host iframe)");
  assert.ok(app.includes("onDeleteClick={() => askToDelete(session)}"), "row delete opens the dialog");
  const dialogs = readFileSync(path.join(root, "Dialogs.tsx"), "utf8");
  const dialog = dialogs.slice(dialogs.indexOf("export function ConfirmDeleteDialog("), dialogs.indexOf("export type TextPromptSpec"));
  assert.ok(dialog.includes('role="alertdialog"') && dialog.includes("This can’t be undone."), "dialog says it's permanent");
  assert.ok(dialog.includes("Delete permanently") && dialog.includes("Cancel"));
});

test("all dialogs are in-app: no window.prompt / confirm / alert anywhere", () => {
  for (const file of ["App.tsx", "WireDebug.tsx", "Dialogs.tsx"]) {
    const source = readFileSync(path.join(root, file), "utf8").replace(/\/\/.*$/gm, "");
    assert.ok(!/window\.(prompt|confirm|alert)\(/.test(source), `${file} must not use native dialogs`);
  }
  assert.ok(app.includes('title: "Change task summary"'), "summary editing uses the in-app text dialog");
});

test("past sessions keep the composer and send with Resume & send", () => {
  assert.ok(!app.includes("{!detailSession.archived && ("), "composer isn't hidden for archived sessions");
  assert.ok(!app.includes("detailSession.archived || content.length === 0"), "submit doesn't drop messages to archived sessions");
  assert.ok(app.includes("Resume &amp; send"), "button label");
  assert.ok(app.includes("api.continueSession({ ...args, resume: true })"), "continuing a session resumes it");
  assert.ok(/if \(resuming\) \{[\s\S]*setQueryData[\s\S]*setFilter\("active"\)/.test(app), "shows it as active right away and switches to Active");
  const actions = readFileSync(path.join(root, "../../server/src/actions.ts"), "utf8");
  assert.ok(actions.includes("if (session.archived && !args.resume)"), "server restores an archived session only when asked to resume");
  assert.ok(/\.\.\.unarchive,/.test(actions), "unarchived as part of the accepted turn");
});

test("header terminal button always opens a new tab", () => {
  assert.ok(/<NewTerminalButton onOpen=\{\(\) => openTerminalTab\(detailSession\.id\)\} \/>\s*<SessionMenu/.test(app), "terminal icon stays next to the menu whether tabs are open or not");
  assert.ok(!app.includes('onNewTerminal='), "tab strip never creates terminals");
  assert.ok(!app.includes("TerminalToggle") && !app.includes("terminalOpen"), "no show/hide toggle");
  assert.ok(app.includes('className={`detail-split${hasSidePanel ? " with-side-panel" : ""}`}'), "panel shown while the session has tabs");
  assert.ok(app.includes('label="Resize chat and terminals"'), "chat/terminal divider appears with terminal tabs");
  const panel = readFileSync(path.join(root, "TerminalPanel.tsx"), "utf8");
  assert.ok(panel.includes('from "@wterm/react"') && panel.includes("autoResize") && panel.includes("renderingPaused={!active}"));
  for (const call of ["openTerminal", "terminalOutput", "terminalInput", "terminalResize"]) {
    assert.ok(new RegExp(`api\\s*\\.${call}\\(`).test(panel), call);
  }
  assert.ok(/flex-direction:\s*column/.test(css.slice(css.indexOf("/* Transcript + side panel split."))), "stacks when narrow");
});

test("side panel: typed tabs; closing a terminal tab ends its shell; archive/delete end all", () => {
  const side = readFileSync(path.join(root, "SidePanel.tsx"), "utf8");
  assert.ok(side.includes('role="tablist"') && side.includes('role="tab"') && side.includes('role="tabpanel"'));
  assert.ok(side.includes('kind: "terminal"'), "tabs are typed (terminals today, other kinds later)");
  assert.ok(side.includes("aria-label={`Close ${label}`}"), "every tab has its own close button");
  assert.ok(/const closeSideTab[\s\S]*api\.closeTerminal\(\{ terminal_id: tab\.terminalId \}\)/.test(app), "closing a terminal tab ends its shell");
  assert.ok(app.includes("api.listSessionTerminals({ session_id: detailSessionId })"), "tabs are rebuilt from the pilot");
  assert.ok(app.includes("forgetSidePanel(sessionId); // archiving ended its shells") && app.includes("forgetSidePanel(sessionId); // deleting ended its shells"));
  const actions = readFileSync(path.join(root, "../../server/src/actions.ts"), "utf8");
  assert.ok(actions.includes("if (args.archived) await killSessionTerminal(ctx, args.id);"), "archiving ends the shells");
  assert.ok(actions.includes("await killSessionTerminal(ctx, session.id);"), "deleting ends the shells");
  const panel = readFileSync(path.join(root, "TerminalPanel.tsx"), "utf8");
  assert.ok(panel.includes("terminal closed") && !panel.includes("[terminal restarted]"), "a vanished shell isn't silently replaced");
});

test("side panel and terminal follow the app's light/dark theme", () => {
  const block = css.slice(css.indexOf("/* Side panel: a tab strip"));
  assert.ok(!/#111416|#23292c|#c9d1cc/.test(block), "no hard-coded dark-only colors left");
  assert.ok(/\.terminal-panel-term\.wterm\s*\{[^}]*--term-bg:\s*var\(--side-bg\)/.test(block), "terminal background follows the panel");
  const light = block.slice(block.indexOf(':root[data-color-mode="light"] .side-panel'));
  assert.ok(/\.side-panel\s*\{[^}]*--side-bg:\s*#f4f4f4/.test(light), "light panel matches the light transcript");
  assert.ok(/\.terminal-panel-term\.wterm\s*\{[^}]*--term-fg:\s*#383a42/.test(light), "light terminal palette");
  assert.ok(/--term-color-15:\s*#383a42/.test(light), "ANSI white stays readable on a light background");
});

test("terminal tabs share the pane background and select with an underline only", () => {
  const block = css.slice(css.indexOf("/* Tabs share the terminal's surface."));
  const strip = block.match(/\.side-tabs\s*\{[^}]*\}/)?.[0] ?? "";
  const tab = block.match(/\.side-tab\s*\{[^}]*\}/)?.[0] ?? "";
  const active = block.match(/\.side-tab\.active\s*\{[^}]*\}/)?.[0] ?? "";
  const underline = block.match(/\.side-tab\.active::after\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(strip.includes("background: var(--side-bg)") && strip.includes("box-shadow: inset 0 -1px 0 var(--side-line)"), "one continuous surface with a faint baseline");
  assert.ok(tab.includes("border: 0") && tab.includes("background: transparent") && tab.includes("color: var(--side-dim)"), "inactive tabs are flat and dimmed");
  assert.ok(active.includes("color: var(--side-fg)") && !active.includes("background"), "selected tab has no raised fill");
  assert.ok(underline.includes("height: 2px") && underline.includes("background: var(--side-fg)"), "only a line marks selection");
  const side = readFileSync(path.join(root, "SidePanel.tsx"), "utf8");
  assert.ok(!side.includes("<TerminalIcon />") && !side.includes('className="side-tab-add"'), "tab strip changes only style, not terminal controls");
});

test("switching Active/Past never changes the selected session", () => {
  assert.ok(/resolveSelectedId\(\s*current,\s*sessions\.map\(\(item\) => item\.id\),\s*sessionGroups\.flatMap/.test(app), "selection is judged against all sessions, not just the visible filter");
  assert.ok(app.includes("autoPickFirst }"), "only the first load auto-picks");
  assert.ok(!app.includes("const next = refreshed.data?.sessions.find("), "refetch never chooses a replacement selection");
  assert.ok(app.includes("Select a task to see its conversation."));
});

test("archiving keeps the list filter and clears only the archived selection", () => {
  const handler = app.slice(app.indexOf("const changeArchiveState = async"), app.indexOf("const askToDelete ="));
  assert.ok(handler.includes('setSelectedId((current) => current === sessionId ? null : current)'), "other open agents stay selected");
  assert.ok(!handler.includes('setFilter("inactive")'), "archiving does not jump to Past");
  assert.ok(handler.includes('setFilter("active")'), "restoring still returns to Active");
  assert.ok(handler.includes('await sessionsQuery.refetch()'), "archived rows leave the list without deleting the transcript");
});

test("session rows are as tall as the Filter sessions box", () => {
  const height = (sel) => css.match(new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*min-height:\\s*(\\d+)px`, "m"))?.[1];
  assert.equal(height(".session-row"), "32");
  assert.equal(height(".session-row"), height(".session-filter"), "same height as the filter row");
  assert.ok(/@media \(pointer: coarse\) \{ \.session-row \{ min-height: 40px; \} \}/.test(css), "roomier tap targets on touch screens");
});

test("Sending counts from the moment of sending and keeps ticking", () => {
  assert.ok(app.includes('<WorkingIndicator label="Sending" elapsedSeconds={sendingElapsedSeconds}'), "not from the previous prompt");
  assert.equal((app.match(/setPendingSentAtMs\(Date\.now\(\)\)/g) ?? []).length, 3, "stamped on send, a queued send, and a new task");
  assert.ok(/if \(!liveWork && !promptPending && !startingDraft\) return;/.test(app), "the clock ticks while a prompt or task startup is pending, not only while a turn runs");
});

test("queued first prompts retry after pilot restart instead of spinning forever", () => {
  assert.ok(app.includes('api.recoverPendingAgents({})'), "the UI polls the durable startup queue");
  assert.ok(app.includes('refetchInterval: 5000'), "the retry poll is periodic");
  assert.ok(app.includes('return pilotSessionId === null ? "Connecting" : "Starting"'), "queued agents show Connecting without naming a service");
  assert.ok(app.includes('api.retryAgentStart({ id: detailSession.id })'), "a rejected start has a manual retry");
  assert.ok(app.includes('Your first message is saved. Connecting…'), "the prompt is visibly retained");
  assert.ok(!app.includes("model_id: queued.model"), "first messages leave model selection to the server");
  assert.ok(!app.includes('Fallback pickup is queued'), "no promise of an unclaimed supervisor");
});

test("sort menu shares the Active/Past row, aligned to the right", () => {
  const menu = readFileSync(path.join(root, "SortMenu.tsx"), "utf8");
  assert.ok(app.includes('className="list-controls"'));
  assert.ok(/<SortMenu value=\{sortMode\} onChange=\{setSortMode\}/.test(app));
  assert.ok(/\.list-controls\s*\{[^}]*justify-content:\s*space-between/.test(css));
  for (const text of ["Priority", "Needs you first, then finished -> working -> idle", "Updated", "Last prompt or reply first", "Created", "Newest agent first"]) {
    assert.ok(menu.includes(text), `sort menu has ${text}`);
  }
  assert.ok(menu.includes('role="menuitemradio"') && menu.includes('aria-expanded={open}'));
});
