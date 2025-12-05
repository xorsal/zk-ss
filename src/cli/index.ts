#!/usr/bin/env node
/**
 * ZK Secret Santa CLI
 *
 * Interactive CLI for playing Secret Santa on Aztec.
 * Uses deterministic account generation from passphrases.
 */

import { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode, type AztecNode } from "@aztec/aztec.js/node";
import { TestWallet } from "@aztec/test-wallet/server";

import { getOrDeployWallet } from "./services/wallet.js";
import { deployContract, connectToContract } from "./services/contract.js";
import {
  loadConfig,
  updateConfig,
  hasContractAddress,
  getNodeUrl,
  getNetwork,
  setNetwork,
} from "./services/config.js";
import { registerAdminCommands, viewStatus } from "./commands/admin.js";
import { registerPlayerCommands } from "./commands/player.js";
import * as display from "./utils/display.js";
import * as prompts from "./utils/prompts.js";

// Version from package.json
const VERSION = "1.0.0";

// Global state for the CLI session
let aztecNode: AztecNode | null = null;
let testWallet: TestWallet | null = null;
let cachedAccountAddress: AztecAddress | null = null;
let cachedSecretKey: Fr | null = null;
let globalPassphrase: string | null = null;

/**
 * Initialize TestWallet connection.
 */
async function initTestWallet(): Promise<{ wallet: TestWallet; node: AztecNode }> {
  if (testWallet && aztecNode) return { wallet: testWallet, node: aztecNode };

  const nodeUrl = getNodeUrl();
  const network = getNetwork();
  display.step(`Connecting to ${network} (${nodeUrl})...`);

  const node = createAztecNodeClient(nodeUrl);

  try {
    await waitForNode(node);
  } catch (err) {
    display.error(`Failed to connect to Aztec node at ${nodeUrl}`);
    if (network === "sandbox") {
      display.info("Make sure the Aztec sandbox is running: aztec start --sandbox");
    } else {
      display.info("Check your network connection or try --sandbox for local development");
    }
    process.exit(1);
  }

  // Create TestWallet
  testWallet = await TestWallet.create(node);
  aztecNode = node;

  display.success(`Connected to ${network}`);
  return { wallet: testWallet, node: aztecNode };
}

/**
 * Get wallet from passphrase, prompting if needed.
 */
async function getWallet(): Promise<{ wallet: TestWallet; accountAddress: AztecAddress; secretKey: Fr; node: AztecNode }> {
  // Use cached account if available
  if (testWallet && cachedAccountAddress && cachedSecretKey && aztecNode) {
    return { wallet: testWallet, accountAddress: cachedAccountAddress, secretKey: cachedSecretKey, node: aztecNode };
  }

  const { wallet: tw, node } = await initTestWallet();

  // Use global passphrase if set, otherwise prompt
  const passphrase = globalPassphrase || await prompts.promptPassphrase();

  display.step("Initializing wallet...");

  const { wallet, accountAddress, secretKey, isNewDeployment } = await getOrDeployWallet(
    tw,
    passphrase,
    true // Deploy if needed
  );

  if (isNewDeployment) {
    display.success("Account deployed!");
  }

  display.walletInfo(accountAddress.toString(), isNewDeployment);

  // Cache account info for this session
  cachedAccountAddress = accountAddress;
  cachedSecretKey = secretKey;

  return { wallet, accountAddress, secretKey, node };
}

/**
 * Get wallet for admin commands (doesn't need secret key).
 */
async function getAdminWallet(): Promise<{ wallet: TestWallet; accountAddress: AztecAddress; node: AztecNode }> {
  const { wallet, accountAddress, node } = await getWallet();
  return { wallet, accountAddress, node };
}

/**
 * Setup command - configure contract address.
 */
async function setup(): Promise<void> {
  display.header("ZK Secret Santa Setup");

  // Get wallet first
  const { wallet, accountAddress, node } = await getWallet();

  // Check if we already have a contract
  if (hasContractAddress()) {
    const config = loadConfig();
    display.info(`Current contract: ${config.contractAddress}`);

    const reconfigure = await prompts.promptConfirm("Reconfigure contract?");
    if (!reconfigure) {
      return;
    }
  }

  // Ask what to do
  const action = await prompts.promptContractSetup();

  if (action === "deploy") {
    display.step("Deploying new SecretSanta contract...");

    const contract = await deployContract(wallet, accountAddress);
    const contractAddress = contract.address.toString();

    updateConfig({ contractAddress });

    display.contractInfo(contractAddress, true);
    display.success("Contract deployed and saved to config!");
  } else {
    const contractAddress = await prompts.promptContractAddress();

    // Verify contract exists
    try {
      await connectToContract(wallet, AztecAddress.fromString(contractAddress), node);
      updateConfig({ contractAddress });

      display.contractInfo(contractAddress);
      display.success("Connected to contract and saved to config!");
    } catch (err: any) {
      display.error(`Failed to connect to contract: ${err.message}`);
      process.exit(1);
    }
  }
}

/**
 * Info command - show current configuration.
 */
async function showInfo(): Promise<void> {
  const config = loadConfig();

  display.header("ZK Secret Santa Configuration");
  display.keyValue("Network", config.network || "sandbox");
  display.keyValue("Node URL", config.nodeUrl);
  display.keyValue("Contract", config.contractAddress || "(not set)");
  display.keyValue("Current Game", config.currentGameId?.toString() || "(not set)");
  display.divider();

  if (config.contractAddress) {
    display.info("Run 'yarn cli status' to see game status");
  } else {
    display.info("Run 'yarn cli setup' to configure the contract");
  }
  display.info("Use --sandbox or --devnet to switch networks");
}

/**
 * Main CLI setup.
 */
const program = new Command();

program
  .name("zk-santa")
  .description("ZK Secret Santa - Privacy-preserving gift exchange on Aztec")
  .version(VERSION)
  .option("--sandbox", "Connect to local sandbox (localhost:8080)")
  .option("--devnet", "Connect to Aztec devnet (devnet.aztec-labs.com)")
  .option("-p, --passphrase <passphrase>", "Passphrase for wallet (avoids interactive prompt)")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.sandbox) {
      setNetwork("sandbox");
    } else if (opts.devnet) {
      setNetwork("devnet");
    }
    if (opts.passphrase) {
      globalPassphrase = opts.passphrase;
    }
  });

// Setup command
program
  .command("setup")
  .description("Configure contract (deploy new or connect to existing)")
  .action(async () => {
    try {
      await setup();
    } catch (err: any) {
      display.error(err.message);
      process.exit(1);
    }
  });

// Info command
program
  .command("info")
  .description("Show current configuration")
  .action(async () => {
    try {
      await showInfo();
    } catch (err: any) {
      display.error(err.message);
      process.exit(1);
    }
  });

// Status command (shortcut)
program
  .command("status")
  .description("View current game status")
  .option("--game <id>", "Game ID", parseInt)
  .action(async (options) => {
    try {
      const { wallet, accountAddress, node } = await getAdminWallet();
      await viewStatus(wallet, accountAddress, node, options);
    } catch (err: any) {
      display.error(err.message);
      process.exit(1);
    }
  });

// Register admin commands
registerAdminCommands(program, getAdminWallet);

// Register player commands
registerPlayerCommands(program, getWallet);

// Parse and execute
program.parse();

// Cleanup on exit
process.on("SIGINT", async () => {
  display.info("\nGoodbye!");
  process.exit(0);
});
