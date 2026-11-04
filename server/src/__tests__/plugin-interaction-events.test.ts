import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import { PLUGIN_EVENT_TYPES } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  eventTypeForActivityAction,
  logActivity,
  publishActivity,
  setPluginEventBus,
  type ActivityPublication,
  type LogActivityInput,
} from "../services/activity-log.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * The activity-action → plugin-event mapping is a plugin-facing contract that
 * fails silently: an unmapped action simply produces no event, with no error on
 * either side. Issue-thread interaction cards (ask_user_questions,
 * request_confirmation, suggest_tasks, ...) were logged through six call sites
 * but mapped to nothing, so a plugin subscribed to `issue.interaction.created`
 * never heard about a card being created or resolved.
 */
describe("issue-thread interaction plugin events (mapping)", () => {
  const terminalActions = [
    "issue.thread_interaction_accepted",
    "issue.thread_interaction_rejected",
    "issue.thread_interaction_answered",
    "issue.thread_interaction_cancelled",
    "issue.thread_interaction_expired",
    "issue.thread_interaction_withdrawn",
    "issue.thread_interaction_dismissed",
    "issue.thread_interaction_skipped",
    "issue.thread_interaction_resolved",
  ] as const;

  it("declares both interaction event types as subscribable", () => {
    expect(PLUGIN_EVENT_TYPES).toContain("issue.interaction.created");
    expect(PLUGIN_EVENT_TYPES).toContain("issue.interaction.resolved");
  });

  it("maps interaction creation onto issue.interaction.created", () => {
    expect(eventTypeForActivityAction("issue.thread_interaction_created")).toBe(
      "issue.interaction.created",
    );
  });

  it("maps every terminal interaction action onto the single resolved event", () => {
    // A plugin that just wants to know the card is done should not have to
    // track every terminal action separately — the specific outcome is still
    // available in the payload's `interactionStatus`.
    for (const action of terminalActions) {
      expect(eventTypeForActivityAction(action)).toBe("issue.interaction.resolved");
    }
  });

  it("leaves ambiguous, non-terminal interaction actions unmapped", () => {
    // `_updated` is a tool-action execution-status tick, not the card's own
    // resolution, and `_item_verdicts_submitted` also fires on partial
    // submissions before the interaction is actually resolved. Mapping either
    // to `issue.interaction.resolved` would tell a subscriber the card is
    // settled while it may still be open.
    expect(eventTypeForActivityAction("issue.thread_interaction_updated")).toBeNull();
    expect(eventTypeForActivityAction("issue.thread_interaction_item_verdicts_submitted")).toBeNull();
  });

  it("leaves unrelated activity unmapped", () => {
    expect(eventTypeForActivityAction("issue.thread_interaction_created.v2")).toBeNull();
    expect(eventTypeForActivityAction("some.unmapped.action")).toBeNull();
  });

  it("still maps the legacy underscore actions it already covered", () => {
    expect(eventTypeForActivityAction("issue_comment_added")).toBe("issue.comment.created");
    expect(eventTypeForActivityAction("approval_approved")).toBe("approval.decided");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin interaction event tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue-thread interaction plugin events (payload + bus delivery)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-interaction-events-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(() => {
    setPluginEventBus(createPluginEventBus());
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function captureEvents() {
    const bus = createPluginEventBus();
    const events: PluginEvent[] = [];
    const scoped = bus.forPlugin("test-plugin");
    scoped.subscribe("issue.interaction.created", async (event) => { events.push(event); });
    scoped.subscribe("issue.interaction.resolved", async (event) => { events.push(event); });
    scoped.subscribe("activity.logged", async (event) => { events.push(event); });
    setPluginEventBus(bus);
    return events;
  }

  function interactionInput(overrides: Partial<LogActivityInput> & { companyId: string; entityId: string }): LogActivityInput {
    return {
      actorType: "agent",
      actorId: "agent-1",
      action: "issue.thread_interaction_created",
      entityType: "issue",
      ...overrides,
    };
  }

  it("publishes issue.interaction.created with issueId, interactionId and interactionKind", async () => {
    const companyId = await seedCompany();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    const events = captureEvents();

    await logActivity(db, interactionInput({
      companyId,
      entityId: issueId,
      action: "issue.thread_interaction_created",
      details: {
        interactionId,
        interactionKind: "ask_user_questions",
        interactionStatus: "pending",
      },
    }));

    const created = events.find((event) => event.eventType === "issue.interaction.created");
    expect(created).toBeDefined();
    expect(created?.payload).toMatchObject({ issueId, interactionId, interactionKind: "ask_user_questions" });
  });

  it("publishes every terminal action as issue.interaction.resolved", async () => {
    const companyId = await seedCompany();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    const events = captureEvents();

    await logActivity(db, interactionInput({
      companyId,
      entityId: issueId,
      actorType: "user",
      actorId: "user-1",
      action: "issue.thread_interaction_accepted",
      details: {
        interactionId,
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    }));

    const resolved = events.find((event) => event.eventType === "issue.interaction.resolved");
    expect(resolved).toBeDefined();
    expect(resolved?.payload).toMatchObject({
      issueId,
      interactionId,
      interactionKind: "request_confirmation",
      interactionStatus: "accepted",
    });
  });

  it("publishes activity.logged through the plugin bus for every activity, not only the live feed", async () => {
    // `activity.logged` was declared in PLUGIN_EVENT_TYPES but only ever
    // published through `publishLiveEvent` (the UI's live feed, a separate
    // channel) — a plugin subscribed to it through the bus received nothing.
    const companyId = await seedCompany();
    const issueId = randomUUID();
    const events = captureEvents();

    await logActivity(db, interactionInput({
      companyId,
      entityId: issueId,
      actorType: "system",
      actorId: "system",
      action: "issue.thread_interaction_created",
      details: { interactionId: randomUUID(), interactionKind: "suggest_tasks" },
    }));

    const logged = events.find((event) => event.eventType === "activity.logged");
    expect(logged).toBeDefined();
    expect(logged?.payload).toMatchObject({ action: "issue.thread_interaction_created" });
  });

  it("still publishes activity.logged for an action with no dedicated plugin event", async () => {
    const companyId = await seedCompany();
    const issueId = randomUUID();
    const events = captureEvents();

    await logActivity(db, interactionInput({
      companyId,
      entityId: issueId,
      actorType: "system",
      actorId: "system",
      action: "some.unmapped.action",
      details: null,
    }));

    expect(events.find((event) => event.eventType === "activity.logged")).toBeDefined();
    expect(events).toHaveLength(1);
  });

  it("does not double-publish activity.logged for the activity.logged action itself", async () => {
    const companyId = await seedCompany();
    const issueId = randomUUID();
    const bus = createPluginEventBus();
    const events: PluginEvent[] = [];
    bus.forPlugin("test-plugin").subscribe("activity.logged", async (event) => { events.push(event); });
    setPluginEventBus(bus);

    const publication: ActivityPublication = {
      companyId,
      payload: { action: "activity.logged", entityType: "issue", entityId: issueId },
      pluginEvent: {
        eventId: randomUUID(),
        eventType: "activity.logged",
        occurredAt: new Date().toISOString(),
        companyId,
        entityId: issueId,
        entityType: "issue",
        payload: { action: "activity.logged" },
      },
    };
    publishActivity(publication);
    // `publishPluginDomainEvent` is fire-and-forget (`void bus.emit(...).then(...)`),
    // so let the microtask queue drain before asserting on delivery.
    await new Promise((resolve) => setImmediate(resolve));

    expect(events).toHaveLength(1);
  });
});
