/**
 * Prompt Utils - Inquirer prompt helpers
 */

import { input, password, select, confirm, number } from "@inquirer/prompts";

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
