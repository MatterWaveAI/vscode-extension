import { describe, expect, it } from "vitest";
import { parseWebviewMessage } from "../src/chat/protocol";

/**
 * The webview is the lower-trust side of the channel: its messages are
 * checked, not cast. The parser's contract is that anything malformed is
 * dropped on the floor, never handed to the controller.
 */
describe("parseWebviewMessage", () => {
  it("lets the sidebar and feedback intents through with their fields", () => {
    expect(parseWebviewMessage({ type: "searchConversations", query: "" })).toEqual({ type: "searchConversations", query: "" });
    expect(parseWebviewMessage({ type: "searchConversations", query: "clock" })).toEqual({ type: "searchConversations", query: "clock" });
    expect(parseWebviewMessage({ type: "renameConversation", id: "c_1", title: "New name" })).toEqual({
      type: "renameConversation",
      id: "c_1",
      title: "New name",
    });
    expect(parseWebviewMessage({ type: "deleteConversation", id: "c_1" })).toEqual({ type: "deleteConversation", id: "c_1" });
    expect(parseWebviewMessage({ type: "pinConversation", id: "c_1", pinned: true })).toEqual({ type: "pinConversation", id: "c_1", pinned: true });
    expect(parseWebviewMessage({ type: "archiveConversation", id: "c_1", archived: false })).toEqual({
      type: "archiveConversation",
      id: "c_1",
      archived: false,
    });
    expect(parseWebviewMessage({ type: "exportConversation" })).toEqual({ type: "exportConversation" });
    expect(parseWebviewMessage({ type: "shareConversation" })).toEqual({ type: "shareConversation" });
    expect(parseWebviewMessage({ type: "rateMessage", messageId: "m_1", rating: 1 })).toEqual({ type: "rateMessage", messageId: "m_1", rating: 1 });
    expect(parseWebviewMessage({ type: "rateMessage", messageId: "m_1", rating: -1 })).toEqual({ type: "rateMessage", messageId: "m_1", rating: -1 });
    expect(parseWebviewMessage({ type: "rateMessage", messageId: "m_1", rating: 0 })).toEqual({ type: "rateMessage", messageId: "m_1", rating: 0 });
  });

  it("drops malformed intents instead of passing them on", () => {
    expect(parseWebviewMessage({ type: "renameConversation", id: "c_1" })).toBeNull();
    expect(parseWebviewMessage({ type: "renameConversation", id: "c_1", title: "   " })).toBeNull();
    expect(parseWebviewMessage({ type: "deleteConversation" })).toBeNull();
    expect(parseWebviewMessage({ type: "pinConversation", id: "c_1", pinned: "yes" })).toBeNull();
    expect(parseWebviewMessage({ type: "archiveConversation", archived: true })).toBeNull();
    expect(parseWebviewMessage({ type: "searchConversations", query: 42 })).toBeNull();
    expect(parseWebviewMessage({ type: "rateMessage", messageId: "m_1", rating: 2 })).toBeNull();
    expect(parseWebviewMessage({ type: "rateMessage", messageId: "m_1", rating: "like" })).toBeNull();
    expect(parseWebviewMessage({ type: "matterwave.admin", token: "x" })).toBeNull();
    expect(parseWebviewMessage("ready")).toBeNull();
    expect(parseWebviewMessage(null)).toBeNull();
  });
});
