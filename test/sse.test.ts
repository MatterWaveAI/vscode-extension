import { frameFromEvent, sseEvents } from "@matterwave/sdk";
import { describe, expect, it } from "vitest";
import { fixture, sse } from "./fakeApi";

/**
 * The SDK's reader over this extension's recorded fixtures: the parser is
 * the SDK's to test, this pins that the frames the API writes come through
 * it the way the controller expects them.
 */
async function read(text: string, chunk: number) {
  const body = sse(text, chunk).body;
  if (!body) throw new Error("no body");
  const events = [];
  for await (const event of sseEvents(body)) events.push(event);
  return events;
}

describe("the SDK's SSE reader over a recorded turn", () => {
  const recorded = fixture("turn.sse");

  it("yields every named frame in order and drops the heartbeat", async () => {
    const events = await read(recorded, 7);
    expect(events.map((e) => e.event)).toEqual([
      "message", "title",
      "part_start", "delta", "part_end",
      "part_start", "part_end",
      "part_start", "part_end",
      "part_start", "delta", "delta", "part_end",
      "context", "done",
    ]);
    expect(events.some((e) => e.data.includes("heartbeat"))).toBe(false);
    expect(frameFromEvent(events[1]?.event ?? "", JSON.parse(events[1]?.data ?? ""))).toEqual({ event: "title", id: null, title: "What time is it?" });
  });

  it("keeps ids on buffered frames and none on the others", async () => {
    const events = await read(recorded, 7);
    expect(events[0]?.id).toBeNull();
    expect(events[3]).toMatchObject({ event: "delta", id: "gen_7f3a:1" });
    expect(events.at(-1)?.id).toBeNull();
  });

  it("gives the same frames however the bytes are split", async () => {
    const whole = await read(recorded, recorded.length);
    for (const size of [1, 2, 3, 13, 64]) expect(await read(recorded, size)).toEqual(whole);
  });

  it("types the saved message on done", async () => {
    const events = await read(recorded, 5);
    const done = events.at(-1);
    const frame = frameFromEvent(done?.event ?? "", JSON.parse(done?.data ?? "{}"));
    expect(frame.event).toBe("done");
    if (frame.event === "done") expect(frame.message).toMatchObject({ id: "m_asst", truncated: false });
  });
});
