/**
 * Config Service - Persists CLI configuration
 *
 * Stores contract address, node URL, and current game ID
 * in a local JSON file for reuse across CLI sessions.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

export interface CLIConfig {
  nodeUrl: string;
  network: "sandbox" | "devnet" | "next-devnet" | "custom";
  contractAddress?: string;
  currentGameId?: number;
}

// Network presets
export const NETWORK_URLS = {
  sandbox: "http://localhost:8080",
  devnet: "https://devnet.aztec-labs.com",
  "next-devnet": "https://next.devnet.aztec-labs.com",
} as const;

const DEFAULT_CONFIG: CLIConfig = {
  nodeUrl: NETWORK_URLS.sandbox,
  network: "sandbox",
};

// Config file location - prefer local .zk-santa.json, fallback to ~/.zk-santa.json
const LOCAL_CONFIG_PATH = join(process.cwd(), ".zk-santa.json");
const GLOBAL_CONFIG_PATH = join(homedir(), ".zk-santa.json");

/**
 * Get the config file path to use.
 * Prefers local config if it exists, otherwise uses global.
 */
function getConfigPath(): string {
  if (existsSync(LOCAL_CONFIG_PATH)) {
    return LOCAL_CONFIG_PATH;
  }
  return GLOBAL_CONFIG_PATH;
}

/**
 * Load configuration from file.
 * Returns default config if file doesn't exist.
 */
export function loadConfig(): CLIConfig {
  const configPath = getConfigPath();

  try {
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      const loaded = JSON.parse(content);
      return { ...DEFAULT_CONFIG, ...loaded };
    }
  } catch (error) {
    console.warn(`Warning: Could not load config from ${configPath}`);
  }

  return { ...DEFAULT_CONFIG };
}

/**
 * Save configuration to file.
 * Saves to local config path by default.
 */
export function saveConfig(config: CLIConfig, useGlobal: boolean = false): void {
  const configPath = useGlobal ? GLOBAL_CONFIG_PATH : LOCAL_CONFIG_PATH;

  try {
    // Ensure directory exists
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  } catch (error) {
    throw new Error(`Failed to save config to ${configPath}: ${error}`);
  }
}

/**
 * Update specific config values without overwriting everything.
 */
export function updateConfig(updates: Partial<CLIConfig>): CLIConfig {
  const current = loadConfig();
  const updated = { ...current, ...updates };
  saveConfig(updated);
  return updated;
}

/**
 * Clear the current configuration file.
 */
export function clearConfig(): void {
  saveConfig(DEFAULT_CONFIG);
}

/**
 * Check if a contract address is configured.
 */
export function hasContractAddress(): boolean {
  const config = loadConfig();
  return !!config.contractAddress;
}

/**
 * Get the configured contract address or throw if not set.
 */
export function getContractAddress(): string {
  const config = loadConfig();
  if (!config.contractAddress) {
    throw new Error("No contract address configured. Run 'yarn cli setup' first.");
  }
  return config.contractAddress;
}

/**
 * Get the configured node URL.
 */
export function getNodeUrl(): string {
  const config = loadConfig();
  return config.nodeUrl;
}

/**
 * Set the network (sandbox, devnet, or next-devnet).
 */
export function setNetwork(network: "sandbox" | "devnet" | "next-devnet"): CLIConfig {
  return updateConfig({
    network,
    nodeUrl: NETWORK_URLS[network],
  });
}

/**
 * Get the current network name.
 */
export function getNetwork(): string {
  const config = loadConfig();
  return config.network || "sandbox";
}

/**
 * Set the current game ID for convenience.
 */
export function setCurrentGameId(gameId: number): void {
  updateConfig({ currentGameId: gameId });
}

/**
 * Get the current game ID if set.
 */
export function getCurrentGameId(): number | undefined {
  const config = loadConfig();
  return config.currentGameId;
}
