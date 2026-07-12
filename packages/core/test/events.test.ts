import { describe, expect, it } from "vitest";
import { EventBus, type ChronicleEvent } from "../src/index.js";

describe("EventBus", () => {
  it("emits events to subscribed handlers and supports unsubscribe", async () => {
    const bus = new EventBus();
    const events: ChronicleEvent[] = [];
    const unsubscribe = bus.on((event) => {
      events.push(event);
    });

    await bus.emit({
      type: "migration:start",
      migrationId: "1",
      direction: "up",
      namespace: "default"
    });
    unsubscribe();
    await bus.emit({
      type: "migration:success",
      migrationId: "1",
      direction: "up",
      namespace: "default",
      executionMs: 1
    });

    expect(events).toHaveLength(1);
  });
});
