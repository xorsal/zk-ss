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

/**
 * Print a timestamp for real-time updates.
 */
export function timestamp(): string {
  return new Date().toLocaleTimeString();
}

/**
 * Print an event notification.
 */
export function eventNotification(eventType: string, details: string): void {
  const now = timestamp();
  console.log(chalk.yellow(`[${now}] `) + chalk.cyan(eventType) + `: ${details}`);
}

/**
 * Print slot status with receiver info.
 */
export function slotStatusExtended(
  slot: number,
  isClaimed: boolean,
  hasReceiver: boolean
): void {
  const senderIcon = isClaimed ? chalk.green("●") : chalk.gray("○");
  const receiverIcon = hasReceiver ? chalk.blue(" → ✓") : "";
  const senderStatus = isClaimed ? "Sender registered" : "Available";
  const receiverStatus = hasReceiver ? " (receiver claimed)" : "";
  console.log(`  Slot ${slot}: ${senderIcon} ${senderStatus}${receiverIcon}${receiverStatus}`);
}

/**
 * Print watch mode header.
 */
export function watchHeader(gameId: number): void {
  console.log("");
  console.log(chalk.bold.bgBlue.white(` 👀 Watching Game #${gameId} `));
  console.log(chalk.gray("Press Ctrl+C to stop"));
  console.log("");
}

// ============================================
// Live Display Utilities
// ============================================

/**
 * ANSI escape codes for cursor control.
 */
const ANSI = {
  clearScreen: "\x1b[2J",
  moveTo: (row: number, col: number) => `\x1b[${row};${col}H`,
  moveUp: (n: number) => `\x1b[${n}A`,
  clearLine: "\x1b[2K",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  saveCursor: "\x1b[s",
  restoreCursor: "\x1b[u",
};

/**
 * Live display state for in-place updates.
 */
let liveLineCount = 0;

/**
 * Clear the live display area (move up and clear lines).
 */
export function clearLiveArea(): void {
  if (liveLineCount > 0) {
    process.stdout.write(ANSI.moveUp(liveLineCount));
    for (let i = 0; i < liveLineCount; i++) {
      process.stdout.write(ANSI.clearLine + "\n");
    }
    process.stdout.write(ANSI.moveUp(liveLineCount));
    liveLineCount = 0;
  }
}

/**
 * Write lines to the live area (tracks line count for clearing).
 */
export function writeLive(lines: string[]): void {
  clearLiveArea();
  for (const line of lines) {
    console.log(line);
  }
  liveLineCount = lines.length;
}

/**
 * Render a slot as a visual cell.
 */
function renderSlot(slot: number, senderClaimed: boolean, receiverClaimed: boolean): string {
  if (receiverClaimed) {
    return chalk.bgGreen.black(` ${slot.toString().padStart(2)} `);
  } else if (senderClaimed) {
    return chalk.bgYellow.black(` ${slot.toString().padStart(2)} `);
  } else {
    return chalk.bgGray.white(` ${slot.toString().padStart(2)} `);
  }
}

/**
 * Render a visual slot grid for live display.
 */
export function renderSlotGrid(
  maxSlots: number,
  senderSlots: number[],
  receiverSlots: number[],
  slotsPerRow: number = 8
): string[] {
  const senderSet = new Set(senderSlots);
  const receiverSet = new Set(receiverSlots);
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold("  Slot Status"));
  lines.push("");

  // Build rows
  for (let row = 0; row < Math.ceil(maxSlots / slotsPerRow); row++) {
    let rowStr = "  ";
    for (let col = 0; col < slotsPerRow; col++) {
      const slot = row * slotsPerRow + col + 1;
      if (slot <= maxSlots) {
        rowStr += renderSlot(slot, senderSet.has(slot), receiverSet.has(slot)) + " ";
      }
    }
    lines.push(rowStr);
  }

  lines.push("");
  lines.push(
    "  " +
    chalk.bgGray.white(" ## ") + " Available  " +
    chalk.bgYellow.black(" ## ") + " Sender  " +
    chalk.bgGreen.black(" ## ") + " Complete"
  );
  lines.push("");

  return lines;
}

/**
 * Render game status for live display.
 */
export function renderGameStatus(
  gameId: number,
  phase: number,
  participantCount: number,
  maxParticipants: number,
  senderCount: number,
  receiverCount: number
): string[] {
  const lines: string[] = [];
  const phaseName = PHASE_NAMES[phase] || "Unknown";

  lines.push(chalk.bold.bgBlue.white(` Game #${gameId} `) + "  " + chalk.cyan(phaseName));
  lines.push("");
  lines.push(`  Enrolled: ${participantCount}/${maxParticipants}  |  Senders: ${senderCount}  |  Receivers: ${receiverCount}`);

  return lines;
}

/**
 * Render full live dashboard.
 */
export function renderLiveDashboard(
  gameId: number,
  phase: number,
  participantCount: number,
  maxParticipants: number,
  senderSlots: number[],
  receiverSlots: number[],
  lastUpdate: Date
): string[] {
  const lines: string[] = [];

  // Header with timestamp
  lines.push(chalk.gray("─".repeat(50)));
  lines.push(...renderGameStatus(gameId, phase, participantCount, maxParticipants, senderSlots.length, receiverSlots.length));
  lines.push(...renderSlotGrid(maxParticipants, senderSlots, receiverSlots));
  lines.push(chalk.gray(`  Last update: ${lastUpdate.toLocaleTimeString()}`));
  lines.push(chalk.gray("─".repeat(50)));

  return lines;
}

/**
 * Hide cursor for cleaner live display.
 */
export function hideCursor(): void {
  process.stdout.write(ANSI.hideCursor);
}

/**
 * Show cursor (call on exit).
 */
export function showCursor(): void {
  process.stdout.write(ANSI.showCursor);
}
