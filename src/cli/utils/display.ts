/**
 * Display Utils - Pretty console output with chalk
 */

import chalk from "chalk";
import { PHASE_NAMES } from "../services/contract.js";

/**
 * Print a success message.
 */
export function success(message: string): void {
  console.log(chalk.green("✓ ") + message);
}

/**
 * Print an error message.
 */
export function error(message: string): void {
  console.log(chalk.red("✗ ") + message);
}

/**
 * Print a warning message.
 */
export function warn(message: string): void {
  console.log(chalk.yellow("⚠ ") + message);
}

/**
 * Print an info message.
 */
export function info(message: string): void {
  console.log(chalk.blue("ℹ ") + message);
}

/**
 * Print a step/progress message.
 */
export function step(message: string): void {
  console.log(chalk.cyan("→ ") + message);
}

/**
 * Print a header.
 */
export function header(title: string): void {
  console.log("");
  console.log(chalk.bold.underline(title));
  console.log("");
}

/**
 * Print a key-value pair.
 */
export function keyValue(key: string, value: string | number | boolean): void {
  console.log(`  ${chalk.gray(key + ":")} ${value}`);
}

/**
 * Print a divider line.
 */
export function divider(): void {
  console.log(chalk.gray("─".repeat(50)));
}

/**
 * Print game status in a nice format.
 */
export function gameStatus(gameId: number, phase: number, participantCount: number, maxParticipants?: number): void {
  header(`Game #${gameId} Status`);
  keyValue("Phase", `${PHASE_NAMES[phase] || "Unknown"} (${phase})`);
  if (maxParticipants) {
    keyValue("Participants", `${participantCount} / ${maxParticipants}`);
    keyValue("Available slots", (maxParticipants - participantCount).toString());
  } else {
    keyValue("Participants", participantCount.toString());
  }
  divider();
}

/**
 * Print slot status.
 */
export function slotStatus(
  slot: number,
  isClaimed: boolean,
  hasDeliveryData: boolean
): void {
  const claimedIcon = isClaimed ? chalk.green("●") : chalk.gray("○");
  const dataIcon = hasDeliveryData ? chalk.blue("📦") : "";
  console.log(`  Slot ${slot}: ${claimedIcon} ${isClaimed ? "Claimed" : "Available"} ${dataIcon}`);
}

/**
 * Print contract info.
 */
export function contractInfo(address: string, isNew: boolean = false): void {
  header("Contract");
  keyValue("Address", address);
  if (isNew) {
    success("Newly deployed!");
  }
  divider();
}

/**
 * Print wallet info.
 */
export function walletInfo(address: string, isNew: boolean = false): void {
  header("Wallet");
  keyValue("Address", address);
  if (isNew) {
    success("Account deployed!");
  }
  divider();
}

/**
 * Print a table of slots.
 */
export function slotsTable(
  slots: Array<{ slot: number; claimed: boolean; hasData: boolean }>
): void {
  header("Slots");
  for (const { slot, claimed, hasData } of slots) {
    slotStatus(slot, claimed, hasData);
  }
  divider();
}

/**
 * Format an address for display (truncate middle).
 */
export function formatAddress(address: string, chars: number = 8): string {
  if (address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

/**
 * Print a spinner message (for long operations).
 * Note: This is a simple version. For real spinners, use ora or similar.
 */
export function spinner(message: string): void {
  process.stdout.write(chalk.cyan("⏳ ") + message + "...");
}

/**
 * Clear the spinner line and print result.
 */
export function spinnerDone(success: boolean = true): void {
  process.stdout.write("\r");
  if (success) {
    console.log(chalk.green("✓ ") + "Done!".padEnd(50));
  } else {
    console.log(chalk.red("✗ ") + "Failed!".padEnd(50));
  }
}
