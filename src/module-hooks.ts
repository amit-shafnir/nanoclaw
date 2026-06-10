/**
 * Generic host-side module hook registries.
 *
 * Optional modules (installed via /add-<name> skills) attach to the message
 * path by registering hooks at import time from the src/modules/index.ts
 * barrel. Core calls the run* functions at fixed choke points; with nothing
 * registered every run* is a no-op, so trunk behavior is unchanged until a
 * module registers.
 *
 * The registries are deliberately dumb: no try/catch, no policy. A hook that
 * must fail open or closed implements that inside itself — core cannot know
 * which is right for a given module.
 *
 * This file must stay a leaf module (type-only imports) so modules can import
 * it without creating ESM cycles with router/delivery/container-runner.
 */
import type { DeliveryAddress, InboundEvent } from './channels/adapter.js';
import type { OutboundMessage } from './db/session-db.js';
import type { VolumeMount } from './providers/provider-container-registry.js';
import type { AgentGroup, MessagingGroup, Session } from './types.js';

/**
 * Inbound message gate. Runs in the router's deliverToAgent() after the
 * command gate, immediately before the message is written to the session's
 * inbound.db — covering both the wake and accumulate paths. Return false to
 * refuse the message (the router drops it without writing).
 */
export interface InboundGateContext {
  event: InboundEvent;
  userId: string | null;
  mg: MessagingGroup;
  agentGroup: AgentGroup;
  session: Session;
  /** Where the agent's reply (and any gate alert) will be delivered. */
  deliveryAddr: DeliveryAddress;
}

export type InboundMessageGate = (ctx: InboundGateContext) => boolean | Promise<boolean>;

const inboundGates: InboundMessageGate[] = [];

export function registerInboundMessageGate(gate: InboundMessageGate): void {
  inboundGates.push(gate);
}

/** True when every registered gate allows the message. First refusal short-circuits. */
export async function runInboundMessageGates(ctx: InboundGateContext): Promise<boolean> {
  for (const gate of inboundGates) {
    if (!(await gate(ctx))) return false;
  }
  return true;
}

/**
 * Outbound message gate. Runs in deliverMessage() after the system-action
 * branch (system rows are internal, never platform-delivered) and before any
 * routing/delivery work — agent-to-agent rows included. Return false to
 * refuse delivery: the caller marks the row delivered without sending (no
 * retry loop), so a refusing gate that wants the user told must deliver its
 * own alert through the adapter directly — never via outbound.db, which
 * would recurse through this gate.
 */
export interface OutboundGateContext {
  msg: OutboundMessage;
  session: Session;
}

export type OutboundMessageGate = (ctx: OutboundGateContext) => boolean | Promise<boolean>;

const outboundGates: OutboundMessageGate[] = [];

export function registerOutboundMessageGate(gate: OutboundMessageGate): void {
  outboundGates.push(gate);
}

/** True when every registered gate allows delivery. First refusal short-circuits. */
export async function runOutboundMessageGates(ctx: OutboundGateContext): Promise<boolean> {
  for (const gate of outboundGates) {
    if (!(await gate(ctx))) return false;
  }
  return true;
}

/**
 * Mount contributor. Runs at the end of buildMounts() on every container
 * spawn; returned mounts are appended after core's. Synchronous because
 * buildMounts is synchronous.
 */
export interface MountContext {
  agentGroup: AgentGroup;
  session: Session;
  /** Absolute path of the group's folder under GROUPS_DIR. */
  groupDir: string;
}

export type MountContributor = (ctx: MountContext) => VolumeMount[];

const mountContributors: MountContributor[] = [];

export function registerMountContributor(fn: MountContributor): void {
  mountContributors.push(fn);
}

export function runMountContributors(ctx: MountContext): VolumeMount[] {
  return mountContributors.flatMap((fn) => fn(ctx));
}
