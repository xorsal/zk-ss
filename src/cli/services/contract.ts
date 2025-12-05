/**
 * Contract Service - Deploy and connect to SecretSanta contract
 *
 * Handles contract deployment, registration, and connection
 * for the Secret Santa protocol.
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Contract } from "@aztec/aztec.js/contracts";
import type { AztecNode } from "@aztec/aztec.js/node";
import {
  SecretSantaContract,
  SecretSantaContractArtifact,
} from "../../../artifacts/SecretSanta.js";
import { TestWallet } from "@aztec/test-wallet/server";
import { getSponsoredPaymentMethod } from "./wallet.js";

// Game phase constants (must match contract)
export const PHASE = {
  ENROLLMENT: 1,
  SENDER_REGISTRATION: 2,
  RECEIVER_CLAIM: 3,
  COMPLETED: 4,
} as const;

export const PHASE_NAMES: Record<number, string> = {
  [PHASE.ENROLLMENT]: "Enrollment",
  [PHASE.SENDER_REGISTRATION]: "Sender Registration",
  [PHASE.RECEIVER_CLAIM]: "Receiver Claim",
  [PHASE.COMPLETED]: "Completed",
};

/**
 * Deploy a new SecretSanta contract.
 */
export async function deployContract(
  wallet: TestWallet,
  admin: AztecAddress
): Promise<SecretSantaContract> {
  const paymentMethod = await getSponsoredPaymentMethod(wallet);
  console.log('paymentMethod', paymentMethod);
  const deployMethod = await Contract.deploy(
    wallet,
    SecretSantaContractArtifact,
    [admin],
    "constructor"
  )

  console.log('deploying contract');
  const tx = await deployMethod.send({ from: admin, fee: { paymentMethod } });
  console.log('tx', tx);
  const contract = await tx.deployed();

  console.log('contract deployed', contract.address.toString());
  return contract as SecretSantaContract;
}

/**
 * Connect to an existing SecretSanta contract.
 * Gets the contract instance from the node and registers it with the wallet.
 */
export async function connectToContract(
  wallet: TestWallet,
  contractAddress: AztecAddress,
  node: AztecNode
): Promise<SecretSantaContract> {
  // Get contract instance from the node (L2 state)
  const instance = await node.getContract(contractAddress);
  if (!instance) {
    throw new Error(`Contract not found at ${contractAddress.toString()}`);
  }

  // Register the contract with the wallet
  await wallet.registerContract({
    instance,
    artifact: SecretSantaContractArtifact,
  });

  // Now we can get the contract reference
  return SecretSantaContract.at(contractAddress, wallet);
}

/**
 * Check if a contract exists at the given address.
 */
export async function isContractDeployed(
  wallet: TestWallet,
  contractAddress: AztecAddress
): Promise<boolean> {
  try {
    const metadata = await wallet.getContractMetadata(contractAddress);
    return metadata?.isContractInitialized ?? false;
  } catch {
    return false;
  }
}

/**
 * Get game information from the contract.
 */
export async function getGameInfo(
  contract: SecretSantaContract,
  gameId: bigint,
  caller: AztecAddress
): Promise<{
  phase: number;
  phaseName: string;
  participantCount: number;
  maxParticipants: number;
}> {
  const phase = await contract.methods.get_game_phase(gameId).simulate({ from: caller });
  const participantCount = await contract.methods
    .get_participant_count(gameId)
    .simulate({ from: caller });
  const maxParticipants = await contract.methods
    .get_max_participants(gameId)
    .simulate({ from: caller });

  return {
    phase: Number(phase),
    phaseName: PHASE_NAMES[Number(phase)] || "Unknown",
    participantCount: Number(participantCount),
    maxParticipants: Number(maxParticipants),
  };
}

/**
 * Get slot information for a game.
 */
export async function getSlotInfo(
  contract: SecretSantaContract,
  gameId: bigint,
  slot: number,
  caller: AztecAddress
): Promise<{
  isClaimed: boolean;
  hasDeliveryData: boolean;
}> {
  const isClaimed = await contract.methods
    .is_slot_claimed(gameId, slot)
    .simulate({ from: caller });

  // Check if delivery data exists by trying to read it
  let hasDeliveryData = false;
  try {
    const deliveryData = await contract.methods
      .get_slot_delivery_data(gameId, BigInt(slot))
      .simulate({ from: caller });
    // If first element is non-zero, we have data
    hasDeliveryData = deliveryData[0] !== 0n;
  } catch {
    hasDeliveryData = false;
  }

  return { isClaimed, hasDeliveryData };
}

/**
 * Get all claimed slots for a game.
 */
export async function getClaimedSlots(
  contract: SecretSantaContract,
  gameId: bigint,
  maxSlots: number,
  caller: AztecAddress
): Promise<number[]> {
  const claimedSlots: number[] = [];

  for (let slot = 1; slot <= maxSlots; slot++) {
    const isClaimed = await contract.methods
      .is_slot_claimed(gameId, slot)
      .simulate({ from: caller });
    if (isClaimed) {
      claimedSlots.push(slot);
    }
  }

  return claimedSlots;
}
