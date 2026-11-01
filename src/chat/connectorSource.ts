import type { ConversationSource } from "../api/types";

/**
 * A conversation a connector opened -- one started from a Slack thread --
 * is answered in that thread alone. The API marks it with `source` and
 * refuses a send, edit or regenerate in it with a 409 `connector_conversation`
 * carrying the same `source`. The row's badge and the notice that stands in
 * for the composer are both worded here, once, for the host and the webview.
 */

/** `slack` as "Slack": the connector's id, which the API keeps lower-case, as a name. */
export function connectorName(source: ConversationSource): string {
  const id = source.connector.trim();
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : "its connector";
}

/** "Slack #support"; the connector alone when the channel is unknown. The label carries its own `#`. */
export function sourceLabel(source: ConversationSource): string {
  const name = connectorName(source);
  return source.channel_label ? `${name} ${source.channel_label}` : name;
}

/** The line that stands in for the composer: where the answer is, and where to reply. */
export function connectorNoticeText(source: ConversationSource): string {
  return `Answered in ${sourceLabel(source)} — reply in the thread`;
}
