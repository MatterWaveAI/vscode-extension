import { describe, expect, it } from "vitest";
import { classifyNotificationLink } from "../src/links";

/**
 * Where a notification's link leads. The classifier is the one place that
 * decides, so the tests pin every shape a `link` field arrives in -- the
 * web app's conversation route, another path on the deployment, another
 * origin, and everything that must never be opened.
 */
describe("classifyNotificationLink", () => {
  const base = "https://mw.test";

  it("sends the web app's conversation route into the chat view", () => {
    expect(classifyNotificationLink("/apps/chat?c=c_9", base)).toEqual({ kind: "conversation", conversationId: "c_9" });
    expect(classifyNotificationLink("https://mw.test/apps/chat?c=c_1&x=1", base)).toEqual({
      kind: "conversation",
      conversationId: "c_1",
    });
  });

  it("hands another path of this deployment to the browser, absolute", () => {
    expect(classifyNotificationLink("/pricing", base)).toEqual({ kind: "url", url: "https://mw.test/pricing" });
    expect(classifyNotificationLink("/apps/chat", base)).toEqual({ kind: "url", url: "https://mw.test/apps/chat" });
  });

  it("hands another origin to the browser as itself", () => {
    expect(classifyNotificationLink("https://status.example.com/incident", base)).toEqual({
      kind: "url",
      url: "https://status.example.com/incident",
    });
  });

  it("refuses a scheme no browser tab should be opened for", () => {
    expect(classifyNotificationLink("javascript:alert(1)", base)).toBeNull();
    expect(classifyNotificationLink("file:///C:/Windows", base)).toBeNull();
    expect(classifyNotificationLink("ms-excel:ofe|u|https://mw.test/a.xlsx", base)).toBeNull();
  });

  it("refuses a conversation id that is not one", () => {
    expect(classifyNotificationLink("/apps/chat", base)).toEqual({ kind: "url", url: "https://mw.test/apps/chat" });
    expect(classifyNotificationLink("/apps/chat?c=", base)).toEqual({ kind: "url", url: "https://mw.test/apps/chat?c=" });
    expect(classifyNotificationLink("/apps/chat?c=a%20b", base)).toEqual({
      kind: "url",
      url: "https://mw.test/apps/chat?c=a%20b",
    });
  });

  it("refuses something that is not a URL at all", () => {
    expect(classifyNotificationLink("not a url \u0000", base)).toBeNull();
    expect(classifyNotificationLink("look at /apps/chat?c=c_1", base)).toBeNull();
    expect(classifyNotificationLink("", base)).toBeNull();
  });
});
