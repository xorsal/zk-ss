/**
 * Crypto Service - ECIES encryption/decryption for delivery data
 *
 * Uses ECDH on the Grumpkin curve to establish shared secrets,
 * then AES-128-CBC for symmetric encryption.
 *
 * Format of encrypted data (4 field elements):
 * - Field 0: ephemeral public key X coordinate
 * - Field 1: ephemeral public key Y coordinate
 * - Field 2: ciphertext bytes 0-30 (31 bytes)
 * - Field 3: ciphertext bytes 31-47 + padding (17 bytes + padding)
 *
 * Total ciphertext: 48 bytes (3 AES blocks)
 * Max plaintext: 47 bytes (1 length byte + 46 bytes data)
 */

import { Fr, Fq, type GrumpkinScalar } from "@aztec/foundation/fields";
import { Point } from "@aztec/foundation/fields";
import { Grumpkin, Aes128 } from "@aztec/foundation/crypto";
import { sha256 } from "@aztec/foundation/crypto";
import { deriveEcdhSharedSecret } from "@aztec/stdlib/logs";

const grumpkin = new Grumpkin();
const aes = new Aes128();

// AES-128-CBC block size
const AES_BLOCK_SIZE = 16;
// We use 3 AES blocks = 48 bytes for ciphertext (fits in 2 fields with room to spare)
const CIPHERTEXT_SIZE = 48;
// Max plaintext: 48 - 1 (length byte) = 47 bytes
const MAX_PLAINTEXT_SIZE = 47;

/**
 * Derive AES key and IV from ECDH shared secret.
 * Uses SHA256(sharedSecret.x || sharedSecret.y) to get 32 bytes.
 * First 16 bytes = AES key, last 16 bytes = IV.
 */
async function deriveAesKeyAndIv(
  sharedSecret: Point
): Promise<{ key: Uint8Array; iv: Uint8Array }> {
  // Concatenate x and y coordinates
  const xBuffer = sharedSecret.x.toBuffer();
  const yBuffer = sharedSecret.y.toBuffer();
  const combined = Buffer.concat([xBuffer, yBuffer] as Uint8Array[]);

  // Hash to get 32 bytes
  const hash = sha256(combined);
  const hashArray = Uint8Array.from(hash);

  return {
    key: hashArray.slice(0, 16),
    iv: hashArray.slice(16, 32),
  };
}

/**
 * Encrypt delivery data using ECIES.
 *
 * @param plaintext - The delivery address or data to encrypt (max 47 bytes)
 * @param recipientPubKey - The recipient's public key (Point with x, y coordinates)
 * @returns Array of 4 field elements containing ephemeral pubkey + ciphertext
 */
export async function encryptDeliveryData(
  plaintext: string,
  recipientPubKey: { x: bigint; y: bigint; is_infinite: boolean }
): Promise<[Fr, Fr, Fr, Fr]> {
  // Validate plaintext length
  const plaintextBytes = Buffer.from(plaintext, "utf-8");
  if (plaintextBytes.length > MAX_PLAINTEXT_SIZE) {
    throw new Error(`Delivery data too long (max ${MAX_PLAINTEXT_SIZE} bytes, got ${plaintextBytes.length})`);
  }

  // Convert recipient pubkey to Point
  const recipientPoint = new Point(
    new Fr(recipientPubKey.x),
    new Fr(recipientPubKey.y),
    recipientPubKey.is_infinite
  );

  // 1. Generate ephemeral keypair
  const ephemeralPrivateKey: GrumpkinScalar = Fq.random();
  const ephemeralPublicKey = await grumpkin.mul(
    Grumpkin.generator,
    ephemeralPrivateKey
  );

  // 2. Compute shared secret using ECDH: sharedSecret = ephemeralPrivate * recipientPubKey
  const sharedSecret = await deriveEcdhSharedSecret(
    ephemeralPrivateKey,
    recipientPoint
  );

  // 3. Derive AES key and IV from shared secret
  const { key, iv } = await deriveAesKeyAndIv(sharedSecret);

  // 4. Prepare plaintext with length prefix, padded to 48 bytes
  // Format: [length (1 byte)] [data (up to 47 bytes)] [zero padding to 48 bytes]
  const paddedPlaintext = new Uint8Array(CIPHERTEXT_SIZE);
  paddedPlaintext[0] = plaintextBytes.length;
  paddedPlaintext.set(plaintextBytes, 1);
  // Rest is already zero-padded

  // 5. Encrypt (48 bytes in → 48 bytes out since it's exactly 3 blocks)
  // Note: encryptBufferCBC may add PKCS7 padding, making output 64 bytes
  // We handle this by only using the first 48 bytes
  const ciphertext = await aes.encryptBufferCBC(paddedPlaintext, iv, key);
  const cipherArray = Uint8Array.from(ciphertext);

  // 6. Pack into 4 field elements
  // Field 0-1: ephemeral public key
  // Field 2-3: 48 bytes of ciphertext (31 + 17 bytes)
  const cipherPart1 = Buffer.alloc(32);
  cipherPart1.set(cipherArray.slice(0, 31), 1); // 31 bytes at offset 1

  const cipherPart2 = Buffer.alloc(32);
  cipherPart2.set(cipherArray.slice(31, 48), 1); // 17 bytes at offset 1

  return [
    new Fr(ephemeralPublicKey.x.toBigInt()),
    new Fr(ephemeralPublicKey.y.toBigInt()),
    Fr.fromBufferReduce(cipherPart1),
    Fr.fromBufferReduce(cipherPart2),
  ];
}

/**
 * Decrypt delivery data using ECIES.
 *
 * @param encryptedData - Array of 4 field elements from the contract
 * @param privateKey - The recipient's private key (GrumpkinScalar)
 * @returns The decrypted plaintext string
 */
export async function decryptDeliveryData(
  encryptedData: [bigint, bigint, bigint, bigint],
  privateKey: GrumpkinScalar
): Promise<string> {
  // 1. Extract ephemeral public key from first two fields
  const ephemeralPubKeyX = new Fr(encryptedData[0]);
  const ephemeralPubKeyY = new Fr(encryptedData[1]);
  const ephemeralPubKey = new Point(ephemeralPubKeyX, ephemeralPubKeyY, false);

  // 2. Compute shared secret: sharedSecret = privateKey * ephemeralPubKey
  const sharedSecret = await deriveEcdhSharedSecret(privateKey, ephemeralPubKey);

  // 3. Derive AES key and IV
  const { key, iv } = await deriveAesKeyAndIv(sharedSecret);

  // 4. Extract ciphertext from fields 2 and 3
  const cipher1Buffer = new Fr(encryptedData[2]).toBuffer();
  const cipher2Buffer = new Fr(encryptedData[3]).toBuffer();

  // Reconstruct 48-byte ciphertext
  // Buffer is 32 bytes big-endian, data starts at offset 1
  const ciphertext = new Uint8Array(CIPHERTEXT_SIZE);
  ciphertext.set(Uint8Array.from(cipher1Buffer).slice(1, 32), 0);  // 31 bytes from field 2
  ciphertext.set(Uint8Array.from(cipher2Buffer).slice(1, 18), 31); // 17 bytes from field 3

  // 5. Decrypt (use KeepPadding since we manually handle the format)
  const decrypted = await aes.decryptBufferCBCKeepPadding(ciphertext, iv, key);

  // 6. Extract actual data using length prefix
  const length = decrypted[0];
  if (length > MAX_PLAINTEXT_SIZE) {
    throw new Error(`Invalid decrypted data: length ${length} exceeds max ${MAX_PLAINTEXT_SIZE}`);
  }
  const plaintextBytes = decrypted.subarray(1, 1 + length);

  // Convert to string - decrypted is a Buffer so we can use toString directly
  return plaintextBytes.toString("utf-8");
}

/**
 * Check if encrypted data is empty/unset.
 */
export function isEncryptedDataEmpty(
  data: [bigint, bigint, bigint, bigint]
): boolean {
  return data[0] === 0n && data[1] === 0n && data[2] === 0n && data[3] === 0n;
}
