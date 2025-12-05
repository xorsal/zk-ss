/**
 * Admin Commands - Game management for administrators
 *
 * Commands:
 * - create-game: Create a new Secret Santa game
 * - advance-phase: Move game to the next phase
 * - status: View game status
 */

import { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import { TestWallet } from "@aztec/test-wallet/server";
import {
  connectToContract,
  getGameInfo,
  getClaimedSlots,
  PHASE,
  PHASE_NAMES,
} from "../services/contract.js";
import { getSponsoredPaymentMethod } from "../services/wallet.js";
import {
  loadConfig,
  updateConfig,
  getContractAddress,
} from "../services/config.js";
import * as display from "../utils/display.js";
import * as prompts from "../utils/prompts.js";

/**
 * Create a new game.
 */
export async function createGame(
  wallet: TestWallet,
  callerAddress: AztecAddress,
  node: AztecNode,
  options: { min?: number; max?: number }
): Promise<void> {
  const contractAddress = getContractAddress();
  const contract = await connectToContract(
    wallet,
    AztecAddress.fromString(contractAddress),
    node
  );

  // Get participant limits
  let min = options.min;
  let max = options.max;

  if (!min || !max) {
    const limits = await prompts.promptParticipantLimits();
    min = min || limits.min;
    max = max || limits.max;
  }

  display.step(`Creating game with ${min}-${max} participants...`);

  const paymentMethod = await getSponsoredPaymentMethod(wallet);
  await contract.methods
    .create_game(min, max)
    .send({ from: callerAddress, fee: { paymentMethod } })
    .wait();

  // Get the new game ID
  const nextGameId = await contract.methods
    .get_next_game_id()
    .simulate({ from: callerAddress });
  const gameId = Number(nextGameId) - 1;

  // Save as current game
  updateConfig({ currentGameId: gameId });

  display.success(`Game #${gameId} created!`);
  display.keyValue("Min participants", min.toString());
  display.keyValue("Max participants", max.toString());
  display.keyValue("Phase", PHASE_NAMES[PHASE.ENROLLMENT]);
  display.info(`Game ID saved. Use 'yarn cli status' to check game status.`);
}

/**
 * Advance game to next phase.
 */
export async function advancePhase(
  wallet: TestWallet,
  callerAddress: AztecAddress,
  node: AztecNode,
  options: { game?: number }
): Promise<void> {
  const contractAddress = getContractAddress();
  const contract = await connectToContract(
    wallet,
    AztecAddress.fromString(contractAddress),
    node
  );

  const config = loadConfig();
  const gameId = options.game ?? config.currentGameId;

  if (!gameId) {
    display.error("No game ID specified. Use --game <id> or set current game.");
    return;
  }

  // Get current phase
  const { phase: currentPhase, phaseName } = await getGameInfo(
    contract,
    BigInt(gameId),
    callerAddress
  );

  if (currentPhase === PHASE.COMPLETED) {
    display.warn(`Game #${gameId} is already completed.`);
    return;
  }

  display.step(`Advancing game #${gameId} from ${phaseName}...`);

  const paymentMethod = await getSponsoredPaymentMethod(wallet);
  await contract.methods
    .advance_phase(BigInt(gameId))
    .send({ from: callerAddress, fee: { paymentMethod } })
    .wait();

  // Get new phase
  const { phase: newPhase, phaseName: newPhaseName } = await getGameInfo(
    contract,
    BigInt(gameId),
    callerAddress
  );

  display.success(`Game #${gameId} advanced!`);
  display.keyValue("Previous phase", phaseName);
  display.keyValue("Current phase", newPhaseName);
}

/**
 * View game status.
 */
export async function viewStatus(
  wallet: TestWallet,
  callerAddress: AztecAddress,
  node: AztecNode,
  options: { game?: number }
): Promise<void> {
  const contractAddress = getContractAddress();
  const contract = await connectToContract(
    wallet,
    AztecAddress.fromString(contractAddress),
    node
  );

  const config = loadConfig();
  const gameId = options.game ?? config.currentGameId;

  if (!gameId) {
    display.error("No game ID specified. Use --game <id> or create a game first.");
    return;
  }

  // Get game info
  const { phase, phaseName, participantCount, maxParticipants } = await getGameInfo(
    contract,
    BigInt(gameId),
    callerAddress
  );

  display.gameStatus(gameId, phase, participantCount, maxParticipants);

  // If in sender registration or later, show slots
  if (phase >= PHASE.SENDER_REGISTRATION) {
    display.header("Slot Status");

    // Show slots up to max participants
    const claimedSlots = await getClaimedSlots(
      contract,
      BigInt(gameId),
      maxParticipants,
      callerAddress
    );

    for (let slot = 1; slot <= maxParticipants; slot++) {
      const isClaimed = claimedSlots.includes(slot);

      // Check for delivery data if in receiver claim phase
      let hasData = false;
      if (phase >= PHASE.RECEIVER_CLAIM && isClaimed) {
        try {
          const data = await contract.methods
            .get_slot_delivery_data(BigInt(gameId), BigInt(slot))
            .simulate({ from: callerAddress });
          hasData = data[0] !== 0n;
        } catch {
          // No data
        }
      }

      display.slotStatus(slot, isClaimed, hasData);
    }
    display.divider();
  }

  // Show next actions based on phase
  display.header("Next Actions");
  switch (phase) {
    case PHASE.ENROLLMENT:
      display.info(`Players can enroll with: yarn cli enroll --game ${gameId}`);
      display.info(`Admin can advance phase with: yarn cli admin advance --game ${gameId}`);
      break;
    case PHASE.SENDER_REGISTRATION:
      display.info(`Players can register as senders: yarn cli register --slot <n>`);
      display.info(`Admin can advance phase after all players register.`);
      break;
    case PHASE.RECEIVER_CLAIM:
      display.info(`Players can claim as receivers: yarn cli claim --slot <n>`);
      display.info(`Admin can complete game after all players claim.`);
      break;
    case PHASE.COMPLETED:
      display.info(`Game complete! Senders can view delivery data: yarn cli delivery`);
      break;
  }
}

/**
 * Register admin commands with commander.
 */
export function registerAdminCommands(
  program: Command,
  getWallet: () => Promise<{ wallet: TestWallet; accountAddress: AztecAddress; node: AztecNode }>
): void {
  const admin = program
    .command("admin")
    .description("Admin commands for game management");

  admin
    .command("create")
    .description("Create a new Secret Santa game")
    .option("--min <number>", "Minimum participants", parseInt)
    .option("--max <number>", "Maximum participants", parseInt)
    .action(async (options) => {
      try {
        const { wallet, accountAddress, node } = await getWallet();
        await createGame(wallet, accountAddress, node, options);
      } catch (err: any) {
        display.error(err.message);
        process.exit(1);
      }
    });

  admin
    .command("advance")
    .description("Advance game to the next phase")
    .option("--game <id>", "Game ID", parseInt)
    .action(async (options) => {
      try {
        const { wallet, accountAddress, node } = await getWallet();
        await advancePhase(wallet, accountAddress, node, options);
      } catch (err: any) {
        display.error(err.message);
        process.exit(1);
      }
    });

  admin
    .command("status")
    .description("View game status (alias for global status)")
    .option("--game <id>", "Game ID", parseInt)
    .action(async (options) => {
      try {
        const { wallet, accountAddress, node } = await getWallet();
        await viewStatus(wallet, accountAddress, node, options);
      } catch (err: any) {
        display.error(err.message);
        process.exit(1);
      }
    });
}
