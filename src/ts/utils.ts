import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { registerInitialLocalNetworkAccountsInWallet, TestWallet } from "@aztec/test-wallet/server";
import { createStore, type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import { createPXE, getPXEConfig, type PXE } from "@aztec/pxe/server";
import {
  SecretSantaContract,
  SecretSantaContractArtifact,
} from "../../artifacts/SecretSanta.js";

const { NODE_URL = "http://localhost:8080" } = process.env;

const node = createAztecNodeClient(NODE_URL);
await waitForNode(node);

const { PXE_VERSION = "2" } = process.env;
const pxeVersion = parseInt(PXE_VERSION);
const l1Contracts = await node.getL1ContractAddresses();
const config = getPXEConfig();
const fullConfig = { ...config, l1Contracts };
fullConfig.proverEnabled = true;

/**
 * Setup the PXE and the store
 */
export const setupPXE = async (suffix?: string) => {
  const storeDir = suffix ? `store-${suffix}` : "store";
  const store: AztecLMDBStoreV2 = await createStore("pxe", pxeVersion, {
    dataDirectory: storeDir,
    dataStoreMapSizeKb: 1e6,
  });
  const pxe: PXE = await createPXE(node, fullConfig, { store });
  return { pxe, store };
};

/**
 * Setup the PXE, the store and the wallet with test accounts
 */
export const setupTestSuite = async (suffix?: string) => {
  const { pxe, store } = await setupPXE(suffix);
  const aztecNode = createAztecNodeClient(NODE_URL);
  const wallet: TestWallet = await TestWallet.create(aztecNode);
  const accounts: AztecAddress[] = await registerInitialLocalNetworkAccountsInWallet(wallet);

  return {
    pxe,
    store,
    wallet,
    accounts,
  };
};

export async function deploySecretSanta(
  wallet: Wallet,
  admin: AztecAddress,
): Promise<SecretSantaContract> {
  const contract = await Contract.deploy(
    wallet,
    SecretSantaContractArtifact,
    [admin],
    "constructor",
  )
    .send({ from: admin })
    .deployed();
  return contract as SecretSantaContract;
}
