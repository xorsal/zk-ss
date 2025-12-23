/**
 * ZK Secret Santa - Web Player
 *
 * Simple web interface for participating in ZK Secret Santa games.
 */

import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { PXE } from "@aztec/pxe/server";
import { getPXEConfig } from "@aztec/pxe/config";
import { createPXE } from "@aztec/pxe/client/lazy";
import { AccountManager, type Wallet } from "@aztec/aztec.js/wallet";
import { SchnorrAccountContract } from "@aztec/accounts/schnorr/lazy";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { deriveSigningKey, derivePublicKeyFromSecretKey } from "@aztec/stdlib/keys";
import {
  SecretSantaContract,
  SecretSantaContractArtifact,
} from "../../artifacts/SecretSanta.js";
import { encryptDeliveryData, decryptDeliveryData, isEncryptedDataEmpty } from "./crypto.js";
import { MinimalWallet } from "./MinimalWallet.js";

// Game phase constants
const PHASE = {
  ENROLLMENT: 1,
  SENDER_REGISTRATION: 2,
  RECEIVER_CLAIM: 3,
  COMPLETED: 4,
} as const;

const PHASE_NAMES: Record<number, string> = {
  [PHASE.ENROLLMENT]: "Enrollment",
  [PHASE.SENDER_REGISTRATION]: "Sender Registration",
  [PHASE.RECEIVER_CLAIM]: "Receiver Claim",
  [PHASE.COMPLETED]: "Completed",
};

// Network presets (browser PXE connects directly to remote node)
const NETWORKS: Record<string, string> = {
  "sandbox": "http://localhost:8080",
  "next-devnet": "https://next.devnet.aztec-labs.com/",
  "devnet": "https://devnet.aztec-labs.com/",
};

// Get network from URL query param (default: next-devnet)
function getNetworkFromUrl(): { network: string; url: string } {
  const params = new URLSearchParams(window.location.search);
  const network = params.get("network") || "next-devnet";
  const url = NETWORKS[network] || NETWORKS["next-devnet"];
  return { network, url };
}

// State
let node: AztecNode | null = null;
let pxe: PXE | null = null;
let wallet: Wallet | null = null;
let contract: SecretSantaContract | null = null;
let accountAddress: AztecAddress | null = null;
let secretKey: Fr | null = null;
let gameId: bigint = 1n;
let senderSlot: number | null = null;
let pollInterval: number | null = null;
let maxParticipants = 10;
let currentPhase: number | null = null; // Track phase to avoid re-rendering
let selectedSlot: number | null = null; // Currently selected slot in UI
let isPolling = false; // Prevent concurrent polling
let isTxInProgress = false; // Pause polling during transactions

// DOM Elements
const logEl = document.getElementById("log")!;
const pxeUrlInput = document.getElementById("pxe-url") as HTMLInputElement;
const contractInput = document.getElementById("contract-address") as HTMLInputElement;
const gameIdInput = document.getElementById("game-id") as HTMLInputElement;
const passphraseInput = document.getElementById("passphrase") as HTMLInputElement;
const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement;
const setupHeader = document.getElementById("setup-header")!;
const setupContent = document.getElementById("setup-content")!;
const setupToggle = document.getElementById("setup-toggle")!;
const statusSection = document.getElementById("status-section")!;
const actionSection = document.getElementById("action-section")!;
const phaseNameEl = document.getElementById("phase-name")!;
const participantsEl = document.getElementById("participants")!;
const slotsGridEl = document.getElementById("slots-grid")!;
const actionContentEl = document.getElementById("action-content")!;

// Toggle setup section collapse
function toggleSetup() {
  const isCollapsed = setupContent.style.display === "none";
  setupContent.style.display = isCollapsed ? "block" : "none";
  setupToggle.textContent = isCollapsed ? "▼" : "▶";
}

function collapseSetup() {
  setupContent.style.display = "none";
  setupToggle.textContent = "▶";
}

setupHeader.addEventListener("click", toggleSetup);

// Logging
function log(msg: string, isError = false) {
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement("div");
  entry.className = `log-entry${isError ? " error" : ""}`;
  entry.innerHTML = `<span class="time">${time}</span> - ${msg}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

// Load saved settings
function loadSettings() {
  // Set network from URL query param
  const { network, url } = getNetworkFromUrl();
  pxeUrlInput.value = url;

  // Load saved settings
  const saved = localStorage.getItem("zk-ss-settings");
  if (saved) {
    try {
      const settings = JSON.parse(saved);
      if (settings.contractAddress) contractInput.value = settings.contractAddress;
      if (settings.gameId) gameIdInput.value = settings.gameId;
      if (settings.senderSlot) senderSlot = settings.senderSlot;
    } catch {
      // Ignore
    }
  }

  log(`Ready. Network: ${network}`);
}

// Save settings
function saveSettings() {
  localStorage.setItem("zk-ss-settings", JSON.stringify({
    pxeUrl: pxeUrlInput.value,
    contractAddress: contractInput.value,
    gameId: gameIdInput.value,
    senderSlot,
  }));
}

// Helper: passphrase to secret key
function passphraseToSecretKey(passphrase: string): Fr {
  const paddedPassphrase = passphrase.padEnd(32, "#");
  const bytes = Buffer.from(paddedPassphrase, "utf-8");
  return Fr.fromBufferReduce(bytes);
}

// Helper: get sponsored FPC instance
async function getSponsoredFPCInstance() {
  return await getContractInstanceFromInstantiationParams(
    SponsoredFPCContractArtifact,
    { salt: new Fr(SPONSORED_FPC_SALT) }
  );
}

// Helper: get encryption public key
async function getEncryptionPublicKey(sk: Fr): Promise<{ x: Fr; y: Fr; is_infinite: boolean }> {
  const signingKey = deriveSigningKey(sk);
  const publicKey = await derivePublicKeyFromSecretKey(signingKey);
  return {
    x: new Fr(publicKey.x.toBigInt()),
    y: new Fr(publicKey.y.toBigInt()),
    is_infinite: publicKey.isInfinite,
  };
}

// Helper: get decryption private key
function getDecryptionPrivateKey(sk: Fr) {
  return deriveSigningKey(sk);
}

// Cached payment method
let cachedPaymentMethod: SponsoredFeePaymentMethod | null = null;

async function getSponsoredPaymentMethod(): Promise<SponsoredFeePaymentMethod> {
  if (!cachedPaymentMethod) {
    const fpcInstance = await getSponsoredFPCInstance();
    cachedPaymentMethod = new SponsoredFeePaymentMethod(fpcInstance.address);
  }
  return cachedPaymentMethod;
}

// Connect to PXE and setup wallet
async function connect() {
  try {
    connectBtn.disabled = true;
    connectBtn.textContent = "Connecting...";

    const nodeUrl = pxeUrlInput.value.trim();
    const contractAddr = contractInput.value.trim();
    const passphrase = passphraseInput.value;
    const gameIdValue = gameIdInput.value.trim();

    if (!nodeUrl || !contractAddr || !passphrase) {
      throw new Error("Please fill in all fields");
    }

    const { network } = getNetworkFromUrl();
    log(`Connecting to ${network}...`);

    // Connect to node
    node = createAztecNodeClient(nodeUrl);
    log("Connected to node");

    // Create browser PXE (lazy client)
    log("Setting up browser PXE...");
    const config = getPXEConfig();
    // Sandbox has proving disabled, devnets have it enabled
    config.proverEnabled = network !== "sandbox";

    // Set stable data directory for IndexedDB persistence
    try {
      const { hostname, port } = new URL(nodeUrl);
      const suffix = `${hostname}-${port ?? 'default'}`.replace(/[^a-z0-9-]/gi, '-');
      config.dataDirectory = `aztec-pxe-zk-ss-${suffix}`;
    } catch {
      config.dataDirectory = `aztec-pxe-zk-ss-${network}`;
    }

    pxe = await createPXE(node, config);
    log("PXE ready");

    // Create minimal wallet for bootstrapping
    const minimalWallet = new MinimalWallet(pxe, node);

    // Register SponsoredFPC
    const fpcInstance = await getSponsoredFPCInstance();
    await pxe.registerContract({ instance: fpcInstance, artifact: SponsoredFPCContractArtifact });

    // Create account from passphrase
    log("Creating account from passphrase...");
    const rawKey = passphraseToSecretKey(passphrase);
    secretKey = await poseidon2Hash([rawKey]);
    const signingKey = deriveSigningKey(secretKey);

    const accountContract = new SchnorrAccountContract(signingKey);
    const accountManager = await AccountManager.create(minimalWallet, secretKey, accountContract, Fr.ONE);
    accountAddress = accountManager.address;

    // Check if account is deployed
    let isDeployed = false;
    try {
      const metadata = await pxe.getContractMetadata(accountAddress);
      isDeployed = metadata?.isContractInitialized ?? false;
    } catch {
      isDeployed = false;
    }

    if (!isDeployed) {
      log("Deploying account...");
      const paymentMethod = new SponsoredFeePaymentMethod(fpcInstance.address);
      const deployMethod = await accountManager.getDeployMethod();
      await deployMethod.send({ from: AztecAddress.ZERO, fee: { paymentMethod } }).wait();
      log("Account deployed!");
    }

    // Get wallet - register the account first
    const accountWallet = await accountManager.getAccount();
    const instance = accountManager.getInstance();
    const artifact = await accountManager.getAccountContract().getContractArtifact();
    await minimalWallet.registerContract(instance, artifact, accountManager.getSecretKey());
    minimalWallet.addAccount(accountWallet);
    wallet = minimalWallet;
    log(`Account ready: ${accountAddress.toString().slice(0, 20)}...`);

    // Connect to contract
    log("Connecting to contract...");
    const contractInstance = await node.getContract(AztecAddress.fromString(contractAddr));
    if (!contractInstance) {
      throw new Error("Contract not found");
    }
    await pxe.registerContract({ instance: contractInstance, artifact: SecretSantaContractArtifact });
    contract = SecretSantaContract.at(AztecAddress.fromString(contractAddr), wallet);
    log("Contract ready");

    // Get game ID (auto-detect latest if not provided)
    if (gameIdValue) {
      gameId = BigInt(gameIdValue);
    } else {
      const nextGameId = await contract.methods.get_next_game_id().simulate({ from: accountAddress });
      gameId = BigInt(nextGameId) - 1n;
      if (gameId < 1n) gameId = 1n;
      log(`Auto-detected game ID: ${gameId}`);
      gameIdInput.value = String(gameId);
    }

    // Get max participants
    maxParticipants = Number(await contract.methods.get_max_participants(gameId).simulate({ from: accountAddress }));

    // Save settings
    saveSettings();

    // Show status section
    statusSection.style.display = "block";
    actionSection.style.display = "block";

    // Start polling
    await poll();
    pollInterval = window.setInterval(poll, 5000);

    log("Ready! Polling every 5 seconds...");
    connectBtn.textContent = "Connected";
    collapseSetup();
  } catch (err) {
    log(`Error: ${(err as Error).message}`, true);
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect";
  }
}

// Cached game state from last poll
let cachedState: {
  phase: number;
  participantCount: number;
  maxParticipants: number;
  senderCount: number;
  receiverCount: number;
  senderSlots: number[];
  receiverSlots: number[];
} | null = null;

// Poll game state - single RPC call for all data
async function poll() {
  if (!contract || !accountAddress) return;
  if (isPolling || isTxInProgress) return; // Skip if already polling or tx in progress

  isPolling = true;
  try {
    // Single RPC call for all game state
    const result = await contract.methods.get_game_state(gameId).simulate({ from: accountAddress });
    const [phase, participantCount, max, senderCount, receiverCount, senderSlotsArr, receiverSlotsArr] = result;

    // Convert boolean arrays to slot number arrays
    const senderSlots: number[] = [];
    const receiverSlots: number[] = [];
    for (let i = 0; i < Number(max); i++) {
      if (senderSlotsArr[i]) senderSlots.push(i + 1);
      if (receiverSlotsArr[i]) receiverSlots.push(i + 1);
    }

    cachedState = {
      phase: Number(phase),
      participantCount: Number(participantCount),
      maxParticipants: Number(max),
      senderCount: Number(senderCount),
      receiverCount: Number(receiverCount),
      senderSlots,
      receiverSlots,
    };

    // Update max participants if changed
    maxParticipants = cachedState.maxParticipants;

    // Update status display
    phaseNameEl.textContent = PHASE_NAMES[cachedState.phase] || "Unknown";
    participantsEl.textContent = `${cachedState.participantCount} / ${cachedState.maxParticipants}`;

    // Update slots grid using cached state
    updateSlotsGridFromCache();

    // Only re-render action UI when phase changes (to avoid closing dropdowns)
    if (cachedState.phase !== currentPhase) {
      currentPhase = cachedState.phase;
      updateActionUI(cachedState.phase);
    }
  } catch (err) {
    log(`Poll error: ${(err as Error).message}`, true);
  } finally {
    isPolling = false;
  }
}

// Update slots grid from cached state (no RPC call)
function updateSlotsGridFromCache() {
  if (!cachedState) return;

  slotsGridEl.innerHTML = "";

  for (let i = 0; i < cachedState.maxParticipants; i++) {
    const slot = i + 1; // Slots are 1-indexed
    const isSender = cachedState.senderSlots.includes(slot);
    const isReceiver = cachedState.receiverSlots.includes(slot);

    const slotEl = document.createElement("div");

    // Color based on state: complete (both) > sender only > available
    if (isReceiver) {
      slotEl.className = "slot complete";
      slotEl.title = "Complete (sender + receiver)";
    } else if (isSender) {
      slotEl.className = "slot claimed";
      slotEl.title = "Sender registered";
    } else {
      slotEl.className = "slot available";
      slotEl.title = "Available - Click to select";
    }

    if (slot === selectedSlot) slotEl.classList.add("selected");
    slotEl.textContent = String(slot);

    // Make available slots clickable during sender registration
    if (!isSender && currentPhase === PHASE.SENDER_REGISTRATION) {
      slotEl.addEventListener("click", () => selectSlot(slot));
    }

    slotsGridEl.appendChild(slotEl);
  }
}

// Select a slot from the grid
function selectSlot(slot: number) {
  selectedSlot = slot;
  // Update visual selection
  document.querySelectorAll(".slot").forEach(el => el.classList.remove("selected"));
  document.querySelectorAll(".slot").forEach((el, i) => {
    if (i + 1 === slot) el.classList.add("selected");
  });
  // Update dropdown if exists
  const dropdown = document.getElementById("sender-slot") as HTMLSelectElement | null;
  if (dropdown) dropdown.value = String(slot);
  log(`Selected slot ${slot}`);
}

// Get available slots (from cached state - no RPC call)
function getAvailableSlots(): number[] {
  if (!cachedState) return [];

  const available: number[] = [];
  for (let i = 1; i <= cachedState.maxParticipants; i++) {
    if (!cachedState.senderSlots.includes(i)) {
      available.push(i);
    }
  }
  return available;
}

// Get claimable slots for receiver (has sender, no receiver yet, not own slot)
function getClaimableSlotsForReceiver(): number[] {
  if (!cachedState) return [];

  return cachedState.senderSlots.filter(slot =>
    slot !== senderSlot && !cachedState!.receiverSlots.includes(slot)
  );
}

// Update action UI based on phase
function updateActionUI(phase: number) {
  switch (phase) {
    case PHASE.ENROLLMENT:
      actionContentEl.innerHTML = `
        <p>Join the game to participate!</p>
        <button id="enroll-btn">Enroll in Game</button>
      `;
      document.getElementById("enroll-btn")?.addEventListener("click", enroll);
      break;

    case PHASE.SENDER_REGISTRATION:
      renderSenderRegistration();
      break;

    case PHASE.RECEIVER_CLAIM:
      renderReceiverClaim();
      break;

    case PHASE.COMPLETED:
      renderCompleted();
      break;

    default:
      actionContentEl.innerHTML = "<p>Unknown phase</p>";
  }
}

// Render sender registration UI
function renderSenderRegistration() {
  const slots = getAvailableSlots();

  if (slots.length === 0) {
    actionContentEl.innerHTML = `
      <p>All slots are claimed. Waiting for next phase...</p>
      <button id="refresh-btn" style="background:#666">Refresh</button>
    `;
    document.getElementById("refresh-btn")?.addEventListener("click", () => poll());
    return;
  }

  // Auto-select first available slot if none selected
  if (!selectedSlot || !slots.includes(selectedSlot)) {
    selectedSlot = slots[0];
  }

  const options = slots.map(s =>
    `<option value="${s}" ${s === selectedSlot ? "selected" : ""}>${s}</option>`
  ).join("");

  actionContentEl.innerHTML = `
    <p>Click a green slot above or use the dropdown:</p>
    <label for="sender-slot">Selected slot:</label>
    <select id="sender-slot">${options}</select>
    <button id="register-btn">Register as Sender</button>
    <button id="refresh-btn" style="background:#666; margin-top:8px">Refresh</button>
  `;

  // Sync dropdown with slot selection
  const dropdown = document.getElementById("sender-slot") as HTMLSelectElement;
  dropdown.addEventListener("change", () => {
    selectedSlot = Number(dropdown.value);
    updateSlotsGridFromCache(); // Refresh to show selection
  });

  document.getElementById("register-btn")?.addEventListener("click", registerAsSender);
  document.getElementById("refresh-btn")?.addEventListener("click", () => poll());

  // Update grid to show current selection
  updateSlotsGridFromCache();
}

// Render receiver claim UI
function renderReceiverClaim() {
  if (!senderSlot) {
    actionContentEl.innerHTML = `
      <p>You need to register as a sender first (enter your sender slot):</p>
      <label for="my-slot">Your Sender Slot:</label>
      <input type="number" id="my-slot" min="1" max="${maxParticipants}">
      <button id="save-slot-btn">Save Slot</button>
    `;
    document.getElementById("save-slot-btn")?.addEventListener("click", () => {
      senderSlot = Number((document.getElementById("my-slot") as HTMLInputElement).value);
      saveSettings();
      log(`Saved your sender slot: ${senderSlot}`);
      renderReceiverClaim();
    });
    return;
  }

  const slots = getClaimableSlotsForReceiver();

  if (slots.length === 0) {
    actionContentEl.innerHTML = `
      <p>No slots available to claim. Waiting...</p>
      <button id="refresh-btn" style="background:#666">Refresh</button>
    `;
    document.getElementById("refresh-btn")?.addEventListener("click", () => poll());
    return;
  }

  const options = slots.map(s => `<option value="${s}">${s}</option>`).join("");

  actionContentEl.innerHTML = `
    <label for="receiver-slot">Choose a slot to claim as receiver:</label>
    <select id="receiver-slot">${options}</select>
    <label for="delivery-address">Your delivery address (max 111 chars):</label>
    <textarea id="delivery-address" maxlength="111" rows="3" placeholder="Enter your street address..."></textarea>
    <button id="claim-btn">Claim as Receiver</button>
    <button id="refresh-btn" style="background:#666; margin-top:8px">Refresh</button>
  `;

  document.getElementById("claim-btn")?.addEventListener("click", claimAsReceiver);
  document.getElementById("refresh-btn")?.addEventListener("click", () => poll());
}

// Render completed UI
function renderCompleted() {
  actionContentEl.innerHTML = `
    <p>Game complete! View your recipient's delivery address:</p>
    <label for="view-slot">Your Sender Slot:</label>
    <input type="number" id="view-slot" min="1" max="${maxParticipants}" value="${senderSlot || ""}">
    <button id="view-btn">View Delivery Address</button>
    <div id="delivery-result" class="hidden"></div>
  `;

  document.getElementById("view-btn")?.addEventListener("click", viewDelivery);
}

// Actions
async function enroll() {
  if (!contract || !wallet || !accountAddress || isTxInProgress) return;

  const btn = document.getElementById("enroll-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Enrolling...";

  isTxInProgress = true;
  try {
    log("Enrolling in game...");
    const paymentMethod = await getSponsoredPaymentMethod();
    await contract.methods.enroll(gameId).send({ from: accountAddress, fee: { paymentMethod } }).wait();
    log("Enrolled successfully!");
    await poll();
  } catch (err) {
    log(`Enroll error: ${(err as Error).message}`, true);
    btn.disabled = false;
    btn.textContent = "Enroll in Game";
  } finally {
    isTxInProgress = false;
  }
}

async function registerAsSender() {
  if (!contract || !wallet || !accountAddress || !secretKey || isTxInProgress) return;

  const btn = document.getElementById("register-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Registering...";

  isTxInProgress = true;
  try {
    const slot = Number((document.getElementById("sender-slot") as HTMLSelectElement).value);

    log(`Registering as sender in slot ${slot}...`);

    // Derive encryption public key
    const pubKey = await getEncryptionPublicKey(secretKey);

    const paymentMethod = await getSponsoredPaymentMethod();
    await contract.methods.register_as_sender(gameId, slot, pubKey).send({ from: accountAddress, fee: { paymentMethod } }).wait();

    senderSlot = slot;
    saveSettings();

    log(`Registered as sender in slot ${slot}!`);
    await poll();
  } catch (err) {
    log(`Register error: ${(err as Error).message}`, true);
    btn.disabled = false;
    btn.textContent = "Register as Sender";
  } finally {
    isTxInProgress = false;
  }
}

async function claimAsReceiver() {
  if (!contract || !wallet || !accountAddress || isTxInProgress) return;

  const slot = Number((document.getElementById("receiver-slot") as HTMLSelectElement).value);
  const address = (document.getElementById("delivery-address") as HTMLTextAreaElement).value.trim();

  if (!address) {
    log("Please enter a delivery address", true);
    return;
  }

  const btn = document.getElementById("claim-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Claiming...";

  isTxInProgress = true;
  try {
    log(`Claiming slot ${slot} as receiver...`);

    // Get sender's encryption public key
    const senderPubKey = await contract.methods.get_slot_encryption_key(gameId, BigInt(slot)).simulate({ from: accountAddress });

    // Encrypt delivery address
    log("Encrypting delivery address...");
    const encryptedData = await encryptDeliveryData(address, {
      x: senderPubKey.x,
      y: senderPubKey.y,
      is_infinite: senderPubKey.is_infinite,
    });

    const paymentMethod = await getSponsoredPaymentMethod();
    await contract.methods.claim_as_receiver(gameId, slot, encryptedData).send({ from: accountAddress, fee: { paymentMethod } }).wait();

    log(`Claimed slot ${slot} as receiver!`);
    await poll();
  } catch (err) {
    log(`Claim error: ${(err as Error).message}`, true);
    btn.disabled = false;
    btn.textContent = "Claim as Receiver";
  } finally {
    isTxInProgress = false;
  }
}

async function viewDelivery() {
  if (!contract || !accountAddress || !secretKey) return;

  try {
    const slot = Number((document.getElementById("view-slot") as HTMLInputElement).value);
    const resultEl = document.getElementById("delivery-result")!;

    log(`Fetching delivery data for slot ${slot}...`);

    // Get encrypted delivery data
    const encryptedData = await contract.methods.get_slot_delivery_data(gameId, BigInt(slot)).simulate({ from: accountAddress });

    if (isEncryptedDataEmpty(encryptedData)) {
      resultEl.textContent = "No delivery data found for this slot.";
      resultEl.className = "delivery-result";
      return;
    }

    // Decrypt
    log("Decrypting...");
    const privateKey = getDecryptionPrivateKey(secretKey);
    const decrypted = await decryptDeliveryData(encryptedData, privateKey);

    resultEl.innerHTML = `<strong>Delivery Address:</strong><br>${decrypted}`;
    resultEl.className = "delivery-result";

    log("Delivery address decrypted successfully!");
  } catch (err) {
    log(`View error: ${(err as Error).message}`, true);
  }
}

// Initialize
loadSettings();
connectBtn.addEventListener("click", connect);
