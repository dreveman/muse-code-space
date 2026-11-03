export type StarterCompanionRef = {
  id: string;
  name: string;
};

export type StarterExampleId = "game" | "trip-overview" | "shopping-list";

export type StarterExampleDefinition = {
  id: StarterExampleId;
  preferredCompanionId: string;
  actionLabel: (companionName: string) => string;
  subtitle: (assistantName: string) => string;
  shortTitle: string;
  visiblePrompt: string;
  instructions: (assistantName: string) => string;
};

const STARTER_INSTRUCTIONS_OPEN = "<code-space-starter-instructions>";
const STARTER_INSTRUCTIONS_CLOSE = "</code-space-starter-instructions>";

export function stripStarterInstructions(content: string): string {
  const startIdx = content.indexOf(STARTER_INSTRUCTIONS_OPEN);
  if (startIdx === -1) return content;
  const endIdx = content.indexOf(STARTER_INSTRUCTIONS_CLOSE, startIdx);
  if (endIdx === -1) {
    return content.slice(0, startIdx).trimEnd();
  }
  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + STARTER_INSTRUCTIONS_CLOSE.length).trimStart();
  if (before && after) return `${before}\n\n${after}`;
  return before || after;
}

export function buildStarterPrompt(
  example: StarterExampleDefinition,
  assistantName = "your Muse assistant",
): string {
  const resolvedAssistant = assistantName.trim() || "your Muse assistant";
  return `${example.visiblePrompt}\n\n${STARTER_INSTRUCTIONS_OPEN}\n${example.instructions(resolvedAssistant).trim()}\n${STARTER_INSTRUCTIONS_CLOSE}`;
}

export const STARTER_EXAMPLES: readonly StarterExampleDefinition[] = [
  {
    id: "game",
    preferredCompanionId: "nova",
    actionLabel: (companionName) => `Build a game with ${companionName}`,
    subtitle: (assistantName) => `Trivia with ${assistantName} or a Muse Jump game`,
    shortTitle: "Build a game",
    visiblePrompt: "Let’s build and deploy a custom game together!",
    instructions: (assistantName) => `
You are guiding a user who may have never written or read code before through creating, previewing, and deploying their own playable web game in Code Space.

CRITICAL COMMUNICATION RULES:
- Never use programming jargon (do not mention TypeScript, React, Drizzle, SQLite, schemas, ports, bash commands, or file paths) in your messages or questions.
- Keep your tone warm, encouraging, and focused on game design, fun, and visuals.

STEP 1 — INTERVIEW THE USER FIRST (\`mcp__code_space__AskUserRichForm\`):
Before writing any code, immediately call \`mcp__code_space__AskUserRichForm\` with \`timeout: null\` and these 3 questions:
1. \`kind: "choice"\`, \`header: "Game"\`, \`question: "What kind of game should we build?"\`:
   - \`"Muse Jump"\` — \`"Fast endless runner (like the Chrome Dino game) where you jump and duck past obstacles"\`
   - \`"Muse Trivia Challenge"\` — \`"Interactive trivia game with custom questions powered by ${assistantName}"\`
   - \`"Cosmic Catch"\` — \`"Arcade game where you catch falling stars and power-ups while dodging hazards"\`
2. \`kind: "choice"\`, \`header: "Style"\`, \`question: "What visual vibe should it have?"\`:
   - \`"Retro Arcade"\` — \`"Crisp arcade look with synth sound effects and high-score flair"\`
   - \`"Cozy & Playful"\` — \`"Warm colors, smooth rounded cards, and cheerful animations"\`
   - \`"Neon Space"\` — \`"Dark starfield backdrop with glowing neon accents"\`
3. \`kind: "embed"\`, \`header: "Character"\`, \`question: "Want to sketch your hero character or an obstacle on the Scratchpad? (Optional — skip if you’d like me to design it!)"\`, \`required: false\`, \`embed: { type: "scratchpad" }\`.

STEP 2 — BUILD & OPEN LIVE PREVIEW (\`mcp__code_space__StartPreview\`):
After receiving the user's answers:
- Build a complete, polished, playable web game in your workspace (with touch + keyboard controls, score & high-score tracking, sound effects via Web Audio API, and smooth animations; if the user drew a sketch on the Scratchpad, incorporate their drawing as the hero sprite or emblem).
- Structure it as a Hatch TypeScript Space web app (\`client/\`, \`server/src/schema.ts\`, \`server/src/actions.ts\`, \`drizzle/\`, \`space.json.template\`) when persistence (such as high scores or trivia packs in \`app.db\`) is used, or with a local dev server.
- Start the dev server in the background, verify it responds over HTTP, and call \`mcp__code_space__StartPreview\` so the live **Preview** tab opens automatically for the user to play right inside Code Space.

STEP 3 — DEPLOY & CONNECT WITH ${assistantName.toUpperCase()} (\`mcp__code_space__SendMessageToMuseAssistant\`):
- Once the game is live in Preview, call \`mcp__code_space__SendMessageToMuseAssistant\` to ask ${assistantName} to stage and publish the game as a Hatch Space web artifact from your workspace directory (and if the user chose *Muse Trivia Challenge*, ask ${assistantName} to seed personalized trivia questions into the Space via \`artifact.invoke_action\`).
- Tell the user their game is ready to play in the **Preview** tab and that you’ve asked ${assistantName} to publish it as a Space for them.
`,
  },
  {
    id: "trip-overview",
    preferredCompanionId: "poppy",
    actionLabel: (companionName) => `Build a trip overview page with ${companionName}`,
    subtitle: () => "Timeline of flights, hotels & bookings from your inbox",
    shortTitle: "Build a trip overview page",
    visiblePrompt: "Let’s build a Trip Overview page that stays updated with my travel bookings.",
    instructions: (assistantName) => `
You are guiding a user who may have never written or read code before through creating, previewing, and deploying a personal Trip Overview web app populated by ${assistantName}.

CRITICAL COMMUNICATION RULES:
- Never use programming jargon (do not mention TypeScript, React, Drizzle, SQLite, schemas, ports, bash commands, or file paths) in your messages or questions.
- Keep your tone calm, clear, and focused on helping the user feel confident and organized about their flights, hotels, and bookings.

STEP 1 — INTERVIEW THE USER FIRST (\`mcp__code_space__AskUserRichForm\`):
Before writing any code, immediately call \`mcp__code_space__AskUserRichForm\` with \`timeout: null\` and these 3 questions:
1. \`kind: "choice"\`, \`header: "Trips"\`, \`question: "Which trips should your overview highlight first?"\`:
   - \`"Next upcoming trip"\` — \`"Put my next trip front-and-center with a countdown and full booking timeline"\`
   - \`"All planned trips"\` — \`"Show a trip switcher for all upcoming trips and weekend getaways"\`
   - \`"A trip I'm planning now"\` — \`"Start with a specific destination I’m putting together"\`
2. \`kind: "choice"\`, \`header: "Layout"\`, \`question: "What view gives you the most confidence while traveling?"\`:
   - \`"Day-by-day booking timeline"\` — \`"Chronological timeline of flights, hotel check-ins, transfers, and dining"\`
   - \`"Boarding & check-in cards"\` — \`"At-a-glance cards with confirmation codes, terminals, check-in times, and addresses"\`
   - \`"Timeline + readiness checklist"\` — \`"Full booking timeline paired with a pre-trip checklist and missing-booking alerts"\`
3. \`kind: "text"\`, \`header: "Details"\`, \`question: "Any upcoming destination or preference to start with? (Optional — ${assistantName} will also populate bookings automatically from your email inbox.)"\`, \`required: false\`, \`placeholder: "e.g. Tokyo in May, window seats, or leave blank"\`.

STEP 2 — BUILD & OPEN LIVE PREVIEW (\`mcp__code_space__StartPreview\`):
After receiving the user's answers:
- Build a complete Hatch TypeScript Space web app (\`client/\`, \`server/src/schema.ts\`, \`server/src/actions.ts\`, \`drizzle/\`, \`space.json.template\`) in your workspace.
- Include durable SQLite tables in \`server/src/schema.ts\` for \`trips\` (destination, start/end dates, cover theme, notes) and \`bookings\` (trip_id, category: flight/hotel/car/train/dining/activity, provider, title, confirmation_code, start_time, end_time, location, status: confirmed/check_in_ready/attention, source_email_subject) and expose clean server actions (\`listTrips\`, \`upsertTrip\`, \`upsertBooking\`, \`deleteBooking\`) in \`server/src/actions.ts\`.
- Seed realistic sample bookings (or the destination the user mentioned) so the timeline looks rich immediately, start the local dev server, and call \`mcp__code_space__StartPreview\` so the **Preview** tab opens automatically.

STEP 3 — DEPLOY & SYNC WITH ${assistantName.toUpperCase()} (\`mcp__code_space__SendMessageToMuseAssistant\`):
- Call \`mcp__code_space__SendMessageToMuseAssistant\` with:
  1. The exact workspace path so ${assistantName} can stage and publish the Hatch Space web artifact.
  2. The exact \`artifact.invoke_action\` action names (\`upsertTrip\`, \`upsertBooking\`) and payload fields so ${assistantName} can scan the user's email inbox for flight, hotel, car rental, and reservation confirmations and populate the Trip Overview automatically.
- Let the user know they can explore the live **Preview** tab right now while ${assistantName} publishes the Space and syncs their travel bookings from their inbox.
`,
  },
  {
    id: "shopping-list",
    preferredCompanionId: "tilly",
    actionLabel: (companionName) => `Build a dynamic shopping list with ${companionName}`,
    subtitle: (assistantName) => `Items to buy & package tracking with ${assistantName}`,
    shortTitle: "Build a dynamic shopping list",
    visiblePrompt: "Let’s build a Dynamic Shopping List and package tracker that works with my Muse assistant.",
    instructions: (assistantName) => `
You are guiding a user who may have never written or read code before through creating, previewing, and deploying a Dynamic Shopping List & Shipment Tracker web app powered by ${assistantName}.

CRITICAL COMMUNICATION RULES:
- Never use programming jargon (do not mention TypeScript, React, Drizzle, SQLite, schemas, ports, bash commands, or file paths) in your messages or questions.
- Keep your tone warm, practical, and focused on how they like to shop and track orders.

STEP 1 — INTERVIEW THE USER FIRST (\`mcp__code_space__AskUserRichForm\`):
Before writing any code, immediately call \`mcp__code_space__AskUserRichForm\` with \`timeout: null\` and these 3 questions:
1. \`kind: "choice"\`, \`header: "Layout"\`, \`question: "How would you like your shopping view structured?"\`:
   - \`"Shopping list + live shipments"\` — \`"Items to buy alongside a live tracker for packages on the way"\`
   - \`"Organized by store & category"\` — \`"Grouped neatly by store or category (Groceries, Home, Tech, Wardrobe)"\`
   - \`"Priority board"\` — \`"Columns for Need Now, Restock Soon, and Wishlist"\`
2. \`kind: "choice"\`, \`header: "Assistant sync"\`, \`question: "How should ${assistantName} help keep it updated?"\`:
   - \`"Both shopping list & deliveries"\` — \`"Let ${assistantName} add items I mention and automatically track orders from my email"\`
   - \`"Auto-track package deliveries"\` — \`"Focus on pulling order confirmations, tracking links, and delivery ETAs"\`
   - \`"Remember brand & store preferences"\` — \`"Keep my preferred brands, sizes, and favorite stores attached to each item"\`
3. \`kind: "text"\`, \`header: "Preferences"\`, \`question: "Any favorite stores, recurring items, or personal preferences to start with? (Optional)"\`, \`required: false\`, \`placeholder: "e.g. Whole Foods, oat milk, running shoes, or leave blank"\`.

STEP 2 — BUILD & OPEN LIVE PREVIEW (\`mcp__code_space__StartPreview\`):
After receiving the user's answers:
- Build a complete Hatch TypeScript Space web app (\`client/\`, \`server/src/schema.ts\`, \`server/src/actions.ts\`, \`drizzle/\`, \`space.json.template\`) in your workspace.
- Include durable SQLite tables in \`server/src/schema.ts\` for \`shopping_items\` (name, category, preferred_store, preferred_brand, notes, priority, status: to_buy/ordered/bought, added_by: user/muse) and \`shipments\` (item_name, merchant, carrier, tracking_number, tracking_url, status: ordered/shipped/out_for_delivery/delivered, estimated_delivery) plus \`preferences\` (key, value), and expose server actions (\`listShoppingData\`, \`upsertShoppingItem\`, \`toggleShoppingItem\`, \`upsertShipment\`, \`upsertPreference\`) in \`server/src/actions.ts\`.
- Seed initial items (including any stores/items the user mentioned), start the local dev server, and call \`mcp__code_space__StartPreview\` so the **Preview** tab opens automatically.

STEP 3 — DEPLOY & SYNC WITH ${assistantName.toUpperCase()} (\`mcp__code_space__SendMessageToMuseAssistant\`):
- Call \`mcp__code_space__SendMessageToMuseAssistant\` with:
  1. The exact workspace path so ${assistantName} can stage and publish the Hatch Space web artifact.
  2. The exact \`artifact.invoke_action\` action names (\`upsertShoppingItem\`, \`upsertShipment\`, \`upsertPreference\`) so ${assistantName} can populate active shipments from order/shipping emails and add/update shopping list items whenever the user asks ${assistantName}.
- Let the user know they can try their Dynamic Shopping List in the **Preview** tab right now while ${assistantName} publishes the Space and connects their order updates.
`,
  },
] as const;

export type ResolvedStarterExample<T extends StarterCompanionRef = StarterCompanionRef> = {
  example: StarterExampleDefinition;
  companion: T;
  label: string;
  subtitle: string;
};

/**
 * Assigns each starter example to an available companion, preferring the
 * example's `preferredCompanionId` (Nova for Game, Poppy for Trip Overview,
 * Tilly for Shopping List) and falling back to another available companion if
 * that companion is currently busy on an active task.
 */
export function resolveStarterExamplesForAvailableCompanions<
  T extends StarterCompanionRef,
>(
  availableCompanions: readonly T[],
  assistantName = "your Muse assistant",
): ResolvedStarterExample<T>[] {
  const resolvedAssistant = assistantName.trim() || "your Muse assistant";
  const preferredIds = new Set(STARTER_EXAMPLES.map((ex) => ex.preferredCompanionId));
  const usedIds = new Set<string>();
  const resolved: ResolvedStarterExample<T>[] = [];

  for (const example of STARTER_EXAMPLES) {
    const preferred =
      availableCompanions.find(
        (c) => c.id === example.preferredCompanionId && !usedIds.has(c.id),
      ) ??
      availableCompanions.find(
        (c) => !usedIds.has(c.id) && !preferredIds.has(c.id),
      ) ??
      availableCompanions.find((c) => !usedIds.has(c.id));
    if (!preferred) break;
    usedIds.add(preferred.id);
    resolved.push({
      example,
      companion: preferred,
      label: example.actionLabel(preferred.name),
      subtitle: example.subtitle(resolvedAssistant),
    });
  }

  return resolved;
}
