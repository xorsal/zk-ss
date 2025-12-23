/**
 * Admin Commands - Game management for administrators
 *
 * Commands:
 * - create-game: Create a new Secret Santa game
 * - advance-phase: Move game to the next phase
 * - status: View game status
 * - dashboard: Interactive admin dashboard with live updates
 */

import { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import { TestWallet } from "@aztec/test-wallet/server";
import * as readline from "readline";
import {
  connectToContract,
  getGameInfo,
  getGameState,
  PHASE,
  PHASE_NAMES,
  type GameState,
} from "../services/contract.js";
import { getSponsoredPaymentMethod } from "../services/wallet.js";
import {
  loadConfig,
  updateConfig,
  getContractAddress,
} from "../services/config.js";
import * as display from "../utils/display.js";
import * as prompts from "../utils/prompts.js";

const POLL_INTERVAL_MS = 5000; // 5 seconds

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
  const txStart = Date.now();
  await contract.methods
    .create_game(min, max)
    .send({ from: callerAddress, fee: { paymentMethod } })
    .wait();
  const txDuration = Date.now() - txStart;

  // Get the new game ID
  const nextGameId = await contract.methods
    .get_next_game_id()
    .simulate({ from: callerAddress });
  const gameId = Number(nextGameId) - 1;

  // Save as current game
  updateConfig({ currentGameId: gameId });

  display.success(`Game #${gameId} created!`);
  display.txTiming("Transaction time", txDuration);
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
  const txStart = Date.now();
  await contract.methods
    .advance_phase(BigInt(gameId))
    .send({ from: callerAddress, fee: { paymentMethod } })
    .wait();
  const txDuration = Date.now() - txStart;

  // Get new phase
  const { phase: newPhase, phaseName: newPhaseName } = await getGameInfo(
    contract,
    BigInt(gameId),
    callerAddress
  );

  display.success(`Game #${gameId} advanced!`);
  display.txTiming("Transaction time", txDuration);
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

  // Get full game state in single RPC call
  const state = await getGameState(contract, BigInt(gameId), callerAddress);

  display.gameStatus(gameId, state.phase, state.participantCount, state.maxParticipants);

  // If in sender registration or later, show slots
  if (state.phase >= PHASE.SENDER_REGISTRATION) {
    display.header("Slot Status");

    for (let slot = 1; slot <= state.maxParticipants; slot++) {
      const isClaimed = state.senderSlots.includes(slot);
      const hasReceiver = state.receiverSlots.includes(slot);
      display.slotStatusExtended(slot, isClaimed, hasReceiver);
    }
    display.divider();
  }

  // Show next actions based on phase
  display.header("Next Actions");
  switch (state.phase) {
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
 * Interactive admin dashboard with live polling and hotkeys.
 */
export async function interactiveDashboard(
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

  let currentState: GameState | null = null;
  let isAdvancing = false;
  let statusMessage = "";
  let pollInterval: NodeJS.Timeout | null = null;

  // Render the dashboard
  const render = () => {
    // Clear screen and move to top
    process.stdout.write("\x1b[2J\x1b[H");

    console.log(display.chalk.bold.red(`\n  ADMIN DASHBOARD - Game #${gameId}\n`));

    if (!currentState) {
      console.log("  Loading...");
      return;
    }

    // Phase info with color coding
    const phaseColor = currentState.phase === PHASE.COMPLETED
      ? display.chalk.green
      : display.chalk.yellow;
    console.log(`  Phase: ${phaseColor.bold(currentState.phaseName)}`);
    console.log("");

    // Progress bar based on phase
    const phaseProgress = ["ENROLLMENT", "SENDER_REGISTRATION", "RECEIVER_CLAIM", "COMPLETED"];
    const progressBar = phaseProgress.map((p, i) => {
      if (i < currentState!.phase) return display.chalk.green("●");
      if (i === currentState!.phase) return display.chalk.yellow("◉");
      return display.chalk.dim("○");
    }).join(" → ");
    console.log(`  ${progressBar}`);
    console.log(`  ${display.chalk.dim(phaseProgress.join("   →   "))}`);
    console.log("");

    // Participants
    console.log(`  Participants: ${display.chalk.cyan(currentState.participantCount.toString())} / ${currentState.maxParticipants}`);

    // Phase-specific stats
    if (currentState.phase >= PHASE.SENDER_REGISTRATION) {
      const senderProgress = currentState.senderCount;
      const senderTotal = currentState.participantCount;
      const senderPct = senderTotal > 0 ? Math.round((senderProgress / senderTotal) * 100) : 0;
      console.log(`  Senders Registered: ${display.chalk.cyan(senderProgress.toString())} / ${senderTotal} (${senderPct}%)`);
    }

    if (currentState.phase >= PHASE.RECEIVER_CLAIM) {
      const receiverProgress = currentState.receiverCount;
      const receiverTotal = currentState.participantCount;
      const receiverPct = receiverTotal > 0 ? Math.round((receiverProgress / receiverTotal) * 100) : 0;
      console.log(`  Receivers Claimed: ${display.chalk.cyan(receiverProgress.toString())} / ${receiverTotal} (${receiverPct}%)`);
    }

    console.log("");

    // Slot grid (if applicable)
    if (currentState.phase >= PHASE.SENDER_REGISTRATION) {
      console.log(`  ${display.chalk.dim("Slot Grid:")}`);
      const grid = display.renderSlotGrid(
        currentState.maxParticipants,
        currentState.senderSlots,
        currentState.receiverSlots
      );
      grid.forEach((line) => console.log("  " + line));
      console.log("");
      console.log(`  ${display.chalk.dim("■")} Empty  ${display.chalk.yellow("■")} Sender  ${display.chalk.green("■")} Complete`);
      console.log("");
    }

    // Readiness indicator
    let canAdvance = false;
    let advanceHint = "";
    switch (currentState.phase) {
      case PHASE.ENROLLMENT:
        canAdvance = currentState.participantCount >= 3; // Assuming min 3
        advanceHint = canAdvance
          ? display.chalk.green("Ready to advance to Sender Registration")
          : display.chalk.yellow(`Need at least 3 participants (have ${currentState.participantCount})`);
        break;
      case PHASE.SENDER_REGISTRATION:
        canAdvance = currentState.senderCount === currentState.participantCount;
        advanceHint = canAdvance
          ? display.chalk.green("All senders registered! Ready to advance")
          : display.chalk.yellow(`Waiting for ${currentState.participantCount - currentState.senderCount} more senders`);
        break;
      case PHASE.RECEIVER_CLAIM:
        canAdvance = currentState.receiverCount === currentState.participantCount;
        advanceHint = canAdvance
          ? display.chalk.green("All receivers claimed! Ready to complete")
          : display.chalk.yellow(`Waiting for ${currentState.participantCount - currentState.receiverCount} more receivers`);
        break;
      case PHASE.COMPLETED:
        advanceHint = display.chalk.green("Game completed!");
        break;
    }
    console.log(`  ${advanceHint}`);
    console.log("");

    // Status message (for feedback)
    if (statusMessage) {
      console.log(`  ${statusMessage}`);
      console.log("");
    }

    // Last update time
    console.log(`  ${display.chalk.dim(`Last updated: ${new Date().toLocaleTimeString()}`)}`);
    console.log("");

    // Controls
    console.log(display.chalk.dim("  ─────────────────────────────────────"));
    if (currentState.phase !== PHASE.COMPLETED) {
      if (isAdvancing) {
        console.log(`  ${display.chalk.yellow("Advancing phase...")} `);
      } else {
        console.log(`  Press ${display.chalk.cyan.bold("A")} to advance phase   ${display.chalk.dim("|")}   Press ${display.chalk.cyan.bold("R")} to refresh   ${display.chalk.dim("|")}   Press ${display.chalk.cyan.bold("Q")} to quit`);
      }
    } else {
      console.log(`  Press ${display.chalk.cyan.bold("Q")} to quit`);
    }
    console.log("");
  };

  // Fetch state and render
  const refreshState = async () => {
    try {
      currentState = await getGameState(contract, BigInt(gameId), callerAddress);
      render();
    } catch (err: any) {
      statusMessage = display.chalk.red(`Error: ${err.message}`);
      render();
    }
  };

  // Advance phase
  const doAdvance = async () => {
    if (isAdvancing || !currentState || currentState.phase === PHASE.COMPLETED) return;

    isAdvancing = true;
    statusMessage = display.chalk.yellow("Submitting transaction...");
    render();

    try {
      const paymentMethod = await getSponsoredPaymentMethod(wallet);
      const txStart = Date.now();
      await contract.methods
        .advance_phase(BigInt(gameId))
        .send({ from: callerAddress, fee: { paymentMethod } })
        .wait();
      const txDuration = Date.now() - txStart;

      statusMessage = display.chalk.green(`Phase advanced! (${display.formatDuration(txDuration)})`);
      await refreshState();
    } catch (err: any) {
      statusMessage = display.chalk.red(`Failed to advance: ${err.message}`);
      render();
    } finally {
      isAdvancing = false;
    }
  };

  // Setup keyboard input
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  const cleanup = () => {
    if (pollInterval) clearInterval(pollInterval);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdout.write("\x1b[?25h"); // Show cursor
    console.log("\n");
    display.info("Dashboard closed.");
  };

  // Handle keypress
  process.stdin.on("keypress", async (str, key) => {
    if (key.ctrl && key.name === "c") {
      cleanup();
      process.exit(0);
    }

    const keyName = key.name?.toLowerCase() || str?.toLowerCase();

    switch (keyName) {
      case "a":
        await doAdvance();
        break;
      case "r":
        statusMessage = display.chalk.dim("Refreshing...");
        render();
        await refreshState();
        statusMessage = "";
        break;
      case "q":
        cleanup();
        process.exit(0);
        break;
    }
  });

  // Hide cursor
  process.stdout.write("\x1b[?25l");

  // Initial fetch
  await refreshState();

  // Start polling
  pollInterval = setInterval(async () => {
    if (!isAdvancing) {
      const oldState = currentState ? JSON.stringify({
        phase: currentState.phase,
        senderCount: currentState.senderCount,
        receiverCount: currentState.receiverCount,
        participantCount: currentState.participantCount,
      }) : null;

      await refreshState();

      // Check if state changed
      if (currentState && oldState) {
        const newState = JSON.stringify({
          phase: currentState.phase,
          senderCount: currentState.senderCount,
          receiverCount: currentState.receiverCount,
          participantCount: currentState.participantCount,
        });
        if (newState !== oldState) {
          statusMessage = display.chalk.cyan("State updated!");
          render();
          // Clear status after a moment
          setTimeout(() => {
            statusMessage = "";
            render();
          }, 2000);
        }
      }
    }
  }, POLL_INTERVAL_MS);

  // Keep alive
  await new Promise(() => {});
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

  admin
    .command("dashboard")
    .alias("dash")
    .description("Interactive admin dashboard with live updates")
    .option("--game <id>", "Game ID", parseInt)
    .action(async (options) => {
      try {
        const { wallet, accountAddress, node } = await getWallet();
        await interactiveDashboard(wallet, accountAddress, node, options);
      } catch (err: any) {
        display.error(err.message);
        process.exit(1);
      }
    });
}
