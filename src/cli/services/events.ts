/**
 * Events Service - Fetch and process contract events
 *
 * Provides utilities for fetching SlotClaimed and ReceiverClaimed
 * events from the SecretSanta contract.
 */

import { getDecodedPublicEvents } from "@aztec/aztec.js/events";
import type { AztecNode } from "@aztec/aztec.js/node";
import { SecretSantaContract } from "../../../artifacts/SecretSanta.js";

// Type definitions for events (matches generated types)
export interface SlotClaimedEvent {
  game_id: bigint;
  slot: bigint;
}

export interface ReceiverClaimedEvent {
  game_id: bigint;
  slot: bigint;
}

/**
 * Fetch all SlotClaimed events within a block range.
 */
export async function getSlotClaimedEvents(
  node: AztecNode,
  fromBlock: number,
  numBlocks: number
): Promise<SlotClaimedEvent[]> {
  return getDecodedPublicEvents<SlotClaimedEvent>(
    node,
    SecretSantaContract.events.SlotClaimed,
    fromBlock,
    numBlocks
  );
}

/**
 * Fetch all ReceiverClaimed events within a block range.
 */
export async function getReceiverClaimedEvents(
  node: AztecNode,
  fromBlock: number,
  numBlocks: number
): Promise<ReceiverClaimedEvent[]> {
  return getDecodedPublicEvents<ReceiverClaimedEvent>(
    node,
    SecretSantaContract.events.ReceiverClaimed,
    fromBlock,
    numBlocks
  );
}

/**
 * Get claimed slots for a game using events.
 * More efficient than N individual view function calls.
 */
export async function getClaimedSlotsFromEvents(
  node: AztecNode,
  gameId: bigint,
  fromBlock: number = 0,
  numBlocks: number = 10000
): Promise<number[]> {
  const events = await getSlotClaimedEvents(node, fromBlock, numBlocks);

  return events
    .filter((e) => e.game_id === gameId)
    .map((e) => Number(e.slot));
}

/**
 * Get receiver-claimed slots for a game using events.
 */
export async function getReceiverClaimedSlotsFromEvents(
  node: AztecNode,
  gameId: bigint,
  fromBlock: number = 0,
  numBlocks: number = 10000
): Promise<number[]> {
  const events = await getReceiverClaimedEvents(node, fromBlock, numBlocks);

  return events
    .filter((e) => e.game_id === gameId)
    .map((e) => Number(e.slot));
}
