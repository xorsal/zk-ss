/**
 * Watch Command - Real-time game status updates via events
 *
 * Polls for new blocks and displays slot claim events as they happen.
 */

import { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import { TestWallet } from "@aztec/test-wallet/server";

import { connectToContract, getGameInfo, getClaimedSlots, getReceiverClaimedSlots, PHASE, PHASE_NAMES } from "../services/contract.js";
import { getSlotClaimedEvents, getReceiverClaimedEvents } from "../services/events.js";
import { loadConfig, getContractAddress } from "../services/config.js";
import * as display from "../utils/display.js";

const DEFAULT_POLL_INTERVAL_MS = 5000; // 5 seconds

interface WatchOptions {
  game?: number;
  interval?: number;
  live?: boolean;
}

/**
 * Watch game events in real-time.
 */
export async function watchGame(
  wallet: TestWallet,
  callerAddress: AztecAddress,
  node: AztecNode,
  options: WatchOptions
): Promise<void> {
  const contractAddressStr = getContractAddress();
  if (!contractAddressStr) {
    display.error("No contract configured. Run 'yarn cli setup' first.");
    return;
  }

  const contractAddress = AztecAddress.fromString(contractAddressStr);
  const contract = await connectToContract(wallet, contractAddress, node);

  const config = loadConfig();
  const gameId = options.game ?? config.currentGameId;

  if (!gameId) {
    display.error("No game ID specified. Use --game <id> or set current game.");
    return;
  }

  // Get initial game info
  const { phase, phaseName, participantCount, maxParticipants } = await getGameInfo(
    contract,
    BigInt(gameId),
    callerAddress
  );

  const pollInterval = options.interval ?? DEFAULT_POLL_INTERVAL_MS;
  const isLive = options.live ?? false;

  if (isLive) {
    await watchGameLive(contract, callerAddress, node, gameId, phase, participantCount, maxParticipants, pollInterval);
  } else {
    await watchGameEvents(contract, callerAddress, node, gameId, phase, pollInterval);
  }
}

/**
 * Live dashboard mode - updates slot grid in place.
 */
async function watchGameLive(
  contract: any,
  callerAddress: AztecAddress,
  node: AztecNode,
  gameId: number,
  initialPhase: number,
  participantCount: number,
  maxParticipants: number,
  pollInterval: number
): Promise<void> {
  display.hideCursor();

  console.log("");
  console.log(display.timestamp() + " Starting live display...");
  console.log("");

  let currentPhase = initialPhase;
  let currentParticipants = participantCount;

  // Initial fetch
  const [senderSlots, receiverSlots] = await Promise.all([
    getClaimedSlots(contract, BigInt(gameId), maxParticipants, callerAddress),
    getReceiverClaimedSlots(contract, BigInt(gameId), maxParticipants, callerAddress),
  ]);

  // Render initial state
  const lines = display.renderLiveDashboard(
    gameId, currentPhase, currentParticipants, maxParticipants,
    senderSlots, receiverSlots, new Date()
  );
  display.writeLive(lines);

  // Poll and update
  const intervalId = setInterval(async () => {
    try {
      // Fetch all data in parallel
      const [gameInfo, newSenderSlots, newReceiverSlots] = await Promise.all([
        getGameInfo(contract, BigInt(gameId), callerAddress),
        getClaimedSlots(contract, BigInt(gameId), maxParticipants, callerAddress),
        getReceiverClaimedSlots(contract, BigInt(gameId), maxParticipants, callerAddress),
      ]);

      currentPhase = gameInfo.phase;
      currentParticipants = gameInfo.participantCount;

      // Update display
      const newLines = display.renderLiveDashboard(
        gameId, currentPhase, currentParticipants, maxParticipants,
        newSenderSlots, newReceiverSlots, new Date()
      );
      display.writeLive(newLines);
    } catch (err: any) {
      // Silently ignore errors to keep display clean
    }
  }, pollInterval);

  // Handle cleanup
  const cleanup = () => {
    clearInterval(intervalId);
    display.showCursor();
    console.log("");
    display.info("Stopped watching.");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await new Promise(() => {});
}

/**
 * Event-based watch mode - shows events as they happen.
 */
async function watchGameEvents(
  contract: any,
  callerAddress: AztecAddress,
  node: AztecNode,
  gameId: number,
  initialPhase: number,
  pollInterval: number
): Promise<void> {
  display.watchHeader(gameId);
  display.info(`Poll interval: ${pollInterval}ms`);
  display.divider();

  // Get current block number as starting point
  let lastBlockNumber = await node.getBlockNumber();
  let currentPhase = initialPhase;

  // Track seen events to avoid duplicates
  const seenSlotClaims = new Set<number>();
  const seenReceiverClaims = new Set<number>();

  display.info(`Starting from block ${lastBlockNumber}...`);
  display.divider();

  // Poll for new events
  const intervalId = setInterval(async () => {
    try {
      const currentBlock = await node.getBlockNumber();

      if (currentBlock > lastBlockNumber) {
        const numBlocks = currentBlock - lastBlockNumber;

        // Check for slot claimed events (sender registration)
        if (currentPhase >= PHASE.SENDER_REGISTRATION) {
          try {
            const slotEvents = await getSlotClaimedEvents(node, lastBlockNumber, numBlocks);

            for (const event of slotEvents) {
              if (Number(event.game_id) === gameId && !seenSlotClaims.has(Number(event.slot))) {
                seenSlotClaims.add(Number(event.slot));
                display.eventNotification("SlotClaimed", `Slot ${event.slot} registered by a sender`);
              }
            }
          } catch (err) {
            // Ignore event fetch errors (might not have events yet)
          }
        }

        // Check for receiver claimed events
        if (currentPhase >= PHASE.RECEIVER_CLAIM) {
          try {
            const receiverEvents = await getReceiverClaimedEvents(node, lastBlockNumber, numBlocks);

            for (const event of receiverEvents) {
              if (Number(event.game_id) === gameId && !seenReceiverClaims.has(Number(event.slot))) {
                seenReceiverClaims.add(Number(event.slot));
                display.eventNotification("ReceiverClaimed", `Slot ${event.slot} claimed by a receiver`);
              }
            }
          } catch (err) {
            // Ignore event fetch errors
          }
        }

        lastBlockNumber = currentBlock;

        // Check for phase changes
        try {
          const newInfo = await getGameInfo(contract, BigInt(gameId), callerAddress);
          if (newInfo.phase !== currentPhase) {
            display.divider();
            display.eventNotification("PhaseChanged", `${PHASE_NAMES[currentPhase]} -> ${PHASE_NAMES[newInfo.phase]}`);
            currentPhase = newInfo.phase;
            display.divider();
          }
        } catch (err) {
          // Ignore phase check errors
        }
      }
    } catch (err: any) {
      display.warn(`Poll error: ${err.message}`);
    }
  }, pollInterval);

  // Handle cleanup on Ctrl+C
  const cleanup = () => {
    clearInterval(intervalId);
    display.divider();
    display.info("Stopped watching.");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep the process alive
  await new Promise(() => {}); // Never resolves
}

/**
 * Register watch command.
 */
export function registerWatchCommand(
  program: Command,
  getWallet: () => Promise<{ wallet: TestWallet; accountAddress: AztecAddress; node: AztecNode }>
): void {
  program
    .command("watch")
    .description("Watch game events in real-time")
    .option("--game <id>", "Game ID to watch", parseInt)
    .option("--interval <ms>", "Poll interval in milliseconds", parseInt)
    .option("--live", "Live updating slot grid display")
    .action(async (options) => {
      try {
        const { wallet, accountAddress, node } = await getWallet();
        await watchGame(wallet, accountAddress, node, options);
      } catch (err: any) {
        display.error(err.message);
        process.exit(1);
      }
    });
}
