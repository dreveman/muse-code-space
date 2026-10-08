import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../drizzle/0021_add_system_error_tone.sql", import.meta.url), "utf8");
const app = readFileSync(new URL("../../client/src/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../../client/src/theme.css", import.meta.url), "utf8");
const block = (start, end) => actions.slice(actions.indexOf(start), actions.indexOf(end, actions.indexOf(start)));

test("system errors are marked explicitly, while neutral restart and stop notices stay neutral", () => {
  assert.ok(schema.includes('systemIsError: integer("system_is_error"'));
  assert.ok(actions.includes('system_is_error: event.kind === "system" && event.systemIsError'));
  assert.ok(block('if (event.type === "turn_error")', 'if (event.type === "recovery_failed")').includes('systemIsError: true'));
  assert.ok(block('if (event.type === "recovery_failed")', '// A message between agents').includes('systemIsError: true'));
  assert.ok(block('if (nextStatus === "running" && poll.hasOpenTurn === false)', '// A turn that ended').includes('systemIsError: true'));
  assert.ok(block('if (event.cancelled === true', '// The outcome can carry').includes('content: "Turn stopped."') && !block('if (event.cancelled === true', '// The outcome can carry').includes('systemIsError: true'));
  assert.ok(actions.includes('systemIsError: event.type === "user_input_error"'));
  assert.ok(migration.includes('ADD `system_is_error`') && migration.includes("'The backend restarted and the turn did not resume.%'"), "known historical failures retain error tone");
  assert.ok(app.includes('event.system_is_error ? " system-error" : ""'));
  assert.ok(css.includes('.output-event.system.system-error .message-text { color: #c91b27; }'));
  assert.ok(css.includes(':root[data-color-mode="dark"] .output-event.system.system-error .message-text { color: #ff5252; }'), "errors are vivid red in both themes, not the muted general error color");
});
