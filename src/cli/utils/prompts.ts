/**
 * Prompt Utils - Inquirer prompt helpers
 */

import { input, password, select, confirm, number } from "@inquirer/prompts";
import * as readline from "readline";
import * as display from "./display.js";

/**
 * Prompt for passphrase (masked input).
 */
export async function promptPassphrase(): Promise<string> {
  return await password({
    message: "Enter your passphrase:",
    mask: "*",
    validate: (value) => {
      if (!value || value.length < 4) {
        return "Passphrase must be at least 4 characters";
      }
      return true;
    },
  });
}

/**
 * Prompt for contract address.
 */
export async function promptContractAddress(): Promise<string> {
  return await input({
    message: "Enter contract address:",
    validate: (value) => {
      if (!value.startsWith("0x") || value.length !== 66) {
        return "Invalid address format. Expected 0x followed by 64 hex characters.";
      }
      return true;
    },
  });
}

/**
 * Prompt for game ID.
 */
export async function promptGameId(defaultValue?: number): Promise<number> {
  const result = await number({
    message: "Enter game ID:",
    default: defaultValue,
    validate: (value) => {
      if (value === undefined || value < 1) {
        return "Game ID must be a positive number";
      }
      return true;
    },
  });
  return result!;
}

/**
 * Prompt for slot number.
 */
export async function promptSlot(message: string = "Enter slot number:"): Promise<number> {
  const result = await number({
    message,
    validate: (value) => {
      if (value === undefined || value < 1) {
        return "Slot must be a positive number";
      }
      return true;
    },
  });
  return result!;
}

/**
 * Prompt to select a slot from available slots.
 */
export async function promptSlotFromAvailable(
  availableSlots: number[],
  message: string = "Select a slot:"
): Promise<number> {
  if (availableSlots.length === 0) {
    throw new Error("No available slots");
  }

  return await select({
    message,
    choices: availableSlots.map((slot) => ({
      name: `Slot ${slot}`,
      value: slot,
    })),
  });
}

/**
 * Prompt to select a slot, showing which are available/taken.
 */
export async function promptSlotWithStatus(
  totalSlots: number,
  claimedSlots: number[],
  message: string = "Select a slot:"
): Promise<number> {
  const claimedSet = new Set(claimedSlots);
  const choices = [];

  for (let slot = 1; slot <= totalSlots; slot++) {
    const isClaimed = claimedSet.has(slot);
    choices.push({
      name: isClaimed ? `Slot ${slot} (taken)` : `Slot ${slot} (available)`,
      value: slot,
      disabled: isClaimed ? "(already claimed)" : false,
    });
  }

  return await select({
    message,
    choices,
  });
}

/**
 * Prompt for min/max participants.
 */
export async function promptParticipantLimits(): Promise<{ min: number; max: number }> {
  const min = await number({
    message: "Minimum participants:",
    default: 3,
    validate: (value) => {
      if (value === undefined || value < 3) {
        return "Minimum must be at least 3";
      }
      return true;
    },
  });

  const max = await number({
    message: "Maximum participants:",
    default: 10,
    validate: (value) => {
      if (value === undefined || value < min!) {
        return `Maximum must be at least ${min}`;
      }
      return true;
    },
  });

  return { min: min!, max: max! };
}

/**
 * Prompt for delivery address (for receiver claim).
 */
export async function promptDeliveryAddress(): Promise<string> {
  return await input({
    message: "Enter your delivery address:",
    validate: (value) => {
      if (!value || value.length < 5) {
        return "Please enter a valid delivery address";
      }
      return true;
    },
  });
}

/**
 * Prompt to choose between deploying new contract or connecting to existing.
 */
export async function promptContractSetup(): Promise<"deploy" | "connect"> {
  return await select({
    message: "What would you like to do?",
    choices: [
      { name: "Deploy new contract", value: "deploy" as const },
      { name: "Connect to existing contract", value: "connect" as const },
    ],
  });
}

/**
 * Confirm an action.
 */
export async function promptConfirm(message: string): Promise<boolean> {
  return await confirm({
    message,
    default: true,
  });
}

/**
 * Prompt for node URL.
 */
export async function promptNodeUrl(defaultValue: string = "http://localhost:8080"): Promise<string> {
  return await input({
    message: "Aztec node URL:",
    default: defaultValue,
    validate: (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return "Please enter a valid URL";
      }
    },
  });
}

/**
 * Prompt for admin address.
 */
export async function promptAdminAddress(defaultValue?: string): Promise<string> {
  return await input({
    message: "Enter admin address:",
    default: defaultValue,
    validate: (value) => {
      if (!value.startsWith("0x") || value.length !== 66) {
        return "Invalid address format. Expected 0x followed by 64 hex characters.";
      }
      return true;
    },
  });
}

/**
 * Prompt to select a game phase action.
 */
export async function promptPhaseAction(): Promise<string> {
  return await select({
    message: "What would you like to do?",
    choices: [
      { name: "Enroll in game", value: "enroll" },
      { name: "Register as sender (claim a slot)", value: "register" },
      { name: "Claim as receiver", value: "claim" },
      { name: "View game status", value: "status" },
      { name: "View my delivery data", value: "delivery" },
    ],
  });
}

/**
 * State fetcher callback type for polling prompts.
 */
export type SlotStateFetcher = () => Promise<{
  senderSlots: number[];
  receiverSlots: number[];
  participantCount: number;
}>;

/**
 * Interactive slot selector with background polling.
 * Shows a live-updating slot grid while waiting for user input.
 */
export async function promptSlotWithPolling(
  mode: "sender" | "receiver",
  initialState: { senderSlots: number[]; receiverSlots: number[]; participantCount: number },
  fetchState: SlotStateFetcher,
  pollIntervalMs: number = 5000,
  ownSlot?: number // For receiver mode - to exclude own slot
): Promise<number> {
  return new Promise((resolve, reject) => {
    let currentState = { ...initialState };
    let pollInterval: NodeJS.Timeout | null = null;
    let isResolved = false;

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Calculate available slots based on mode
    const getAvailableSlots = (): number[] => {
      if (mode === "sender") {
        // Available = not yet claimed by a sender
        const available: number[] = [];
        for (let i = 1; i <= currentState.participantCount; i++) {
          if (!currentState.senderSlots.includes(i)) {
            available.push(i);
          }
        }
        return available;
      } else {
        // Receiver mode: available = has sender but no receiver, excluding own slot
        return currentState.senderSlots.filter(
          (slot) => !currentState.receiverSlots.includes(slot) && slot !== ownSlot
        );
      }
    };

    // Render the current state
    const render = () => {
      // Clear screen and move to top
      process.stdout.write("\x1b[2J\x1b[H");

      // Title
      const modeLabel = mode === "sender" ? "SENDER REGISTRATION" : "RECEIVER CLAIM";
      console.log(display.chalk.bold.cyan(`\n  ${modeLabel}\n`));

      // Slot grid
      const grid = display.renderSlotGrid(
        currentState.participantCount,
        currentState.senderSlots,
        currentState.receiverSlots
      );
      grid.forEach((line) => console.log("  " + line));

      // Legend
      console.log("");
      if (mode === "sender") {
        console.log(`  ${display.chalk.green("■")} Available  ${display.chalk.yellow("■")} Claimed`);
      } else {
        console.log(`  ${display.chalk.yellow("■")} Available (has sender)  ${display.chalk.green("■")} Complete  ${display.chalk.dim("■")} No sender`);
        if (ownSlot) {
          console.log(`  ${display.chalk.red(`Your sender slot: ${ownSlot} (cannot claim your own)`)}`);
        }
      }

      // Available slots list
      const available = getAvailableSlots();
      console.log("");
      if (available.length > 0) {
        console.log(`  Available: ${display.chalk.cyan(available.join(", "))}`);
      } else {
        console.log(`  ${display.chalk.red("No slots available!")}`);
      }

      // Last update timestamp
      console.log(`  ${display.chalk.dim(`Updated: ${new Date().toLocaleTimeString()}`)}`);
      console.log("");
    };

    // Poll for updates
    const startPolling = () => {
      pollInterval = setInterval(async () => {
        if (isResolved) return;
        try {
          const newState = await fetchState();
          // Check if state changed
          const senderChanged = JSON.stringify(newState.senderSlots) !== JSON.stringify(currentState.senderSlots);
          const receiverChanged = JSON.stringify(newState.receiverSlots) !== JSON.stringify(currentState.receiverSlots);

          if (senderChanged || receiverChanged) {
            currentState = newState;
            render();
            // Re-show prompt
            rl.prompt();
          }
        } catch (err) {
          // Ignore polling errors
        }
      }, pollIntervalMs);
    };

    // Cleanup function
    const cleanup = () => {
      isResolved = true;
      if (pollInterval) clearInterval(pollInterval);
      rl.close();
    };

    // Handle input
    rl.on("line", (input) => {
      const trimmed = input.trim();

      // Check for refresh command
      if (trimmed.toLowerCase() === "r") {
        fetchState()
          .then((newState) => {
            currentState = newState;
            render();
            rl.prompt();
          })
          .catch(() => {
            console.log(display.chalk.red("  Failed to refresh. Try again."));
            rl.prompt();
          });
        return;
      }

      // Check for quit command
      if (trimmed.toLowerCase() === "q") {
        cleanup();
        reject(new Error("User cancelled"));
        return;
      }

      // Parse slot number
      const slotNum = parseInt(trimmed, 10);
      if (isNaN(slotNum)) {
        console.log(display.chalk.red("  Enter a slot number, 'r' to refresh, or 'q' to quit"));
        rl.prompt();
        return;
      }

      // Validate slot is available
      const available = getAvailableSlots();
      if (!available.includes(slotNum)) {
        console.log(display.chalk.red(`  Slot ${slotNum} is not available. Choose from: ${available.join(", ")}`));
        rl.prompt();
        return;
      }

      // Success!
      cleanup();
      console.log("");
      resolve(slotNum);
    });

    rl.on("close", () => {
      if (!isResolved) {
        cleanup();
        reject(new Error("Input closed"));
      }
    });

    // Initial render and start
    render();
    rl.setPrompt(`  ${display.chalk.cyan("Enter slot number (r=refresh, q=quit):")} `);
    rl.prompt();
    startPolling();
  });
}
