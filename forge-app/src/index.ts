import api, { route, type WebTriggerResponse } from "@forge/api";
import Resolver from "@forge/resolver";
import { acceptInvite, approve, createInvite, decline, refreshConnections, revoke, savePolicy } from "./pairing";
import { relay } from "./relay";
import { onLocalAttachment, onLocalComment, onLocalCommentDeleted, onLocalIssueChange, processMailbox, tick } from "./sync";

// ---------------------------------------------------------------- admin UI backend

/** Defence in depth: the admin page is admin-only, but every call re-checks it. */
async function requireAdmin(): Promise<void> {
  const res = await api.asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`, {
    headers: { Accept: "application/json" },
  });
  const body = (await res.json()) as { permissions?: { ADMINISTER?: { havePermission?: boolean } } };
  if (!body.permissions?.ADMINISTER?.havePermission) throw new Error("Jira administrator permission required");
}

const resolver = new Resolver();
const admin = <P, R>(fn: (payload: P) => Promise<R>) =>
  async ({ payload }: { payload: P }) => {
    await requireAdmin();
    return fn(payload);
  };

resolver.define("createInvite", admin(() => createInvite()));
resolver.define("acceptInvite", admin((p: { connectionId: string; pairingKey: string; siteName: string }) => acceptInvite(p)));
resolver.define("listConnections", admin(() => refreshConnections()));
resolver.define("approve", admin((p: { connectionId: string; siteName: string }) => approve(p.connectionId, p.siteName)));
resolver.define("decline", admin((p: { connectionId: string }) => decline(p.connectionId)));
resolver.define("revoke", admin((p: { connectionId: string }) => revoke(p.connectionId)));
resolver.define("savePolicy", admin((p: { connectionId: string; policy: unknown }) => savePolicy(p.connectionId, p.policy)));
resolver.define("usage", admin(async (p: { from: string; to: string }) => (await relay()).client.usage(p.from, p.to)));

export const handler = resolver.getDefinitions();

// ---------------------------------------------------------------- Jira events

interface IssueEvent {
  eventType: string;
  issue?: { id: string; key: string };
  comment?: { id: string };
  // TODO(verify): exact payload of avi:jira:created:attachment; we accept either shape.
  attachment?: { id: string; issueId?: string };
  changelog?: { items?: Array<{ field: string; fieldId?: string; toString?: string | null; to?: string | null }> };
}

/** Manifest uses filter.ignoreSelf, so changes the app makes itself never loop back here. */
export async function onIssueEvent(event: IssueEvent): Promise<void> {
  const issueId = event.issue?.id ?? event.attachment?.issueId;
  if (!issueId) return; // reconciliation picks up anything we can't place
  switch (event.eventType) {
    case "avi:jira:commented:issue":
      if (event.comment) await onLocalComment(issueId, event.comment.id);
      return;
    case "avi:jira:deleted:comment":
      if (event.comment) await onLocalCommentDeleted(issueId, event.comment.id);
      return;
    case "avi:jira:created:attachment":
      return onLocalAttachment(issueId);
    default:
      return onLocalIssueChange(issueId, event.changelog?.items);
  }
}

// ---------------------------------------------------------------- relay ping + schedule

/** The relay pings this URL when mail is waiting. The ping carries no data. */
export async function onRelayPing(): Promise<WebTriggerResponse> {
  try {
    await processMailbox(2);
  } catch (err) {
    console.warn(`mailbox processing failed: ${String(err)}`); // the scheduled tick retries
  }
  return { statusCode: 204, headers: {}, body: "" };
}

export async function onTick(): Promise<void> {
  await refreshConnections();
  await tick();
}
