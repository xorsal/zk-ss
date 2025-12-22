/**
 * Crypto Service - ECIES encryption/decryption for delivery data
 *
 * Uses ECDH on the Grumpkin curve to establish shared secrets,
 * then AES-128-CBC for symmetric encryption.
 *
 * Format of encrypted data (8 field elements):
 * - Field 0: ephemeral public key X coordinate
 * - Field 1: ephemeral public key Y coordinate
 * - Fields 2-7: ciphertext bytes (6 fields * 31 bytes = 186 bytes capacity)
 *
 * Total ciphertext: 112 bytes (7 AES blocks)
 * Max plaintext: 111 bytes (1 length byte + 111 bytes data)
 *
 * Issue 5 fix: Increased from 4 fields (47 bytes) to 8 fields (111 bytes)
 */

import { Fr, Fq } from "@aztec/foundation/curves/bn254";
import { Point, type GrumpkinScalar } from "@aztec/foundation/curves/grumpkin";
import { Grumpkin } from "@aztec/foundation/crypto/grumpkin";
import { Aes128 } from "@aztec/foundation/crypto/aes128";
import { sha256 } from "@aztec/foundation/crypto/sha256";
import { deriveEcdhSharedSecret } from "@aztec/stdlib/logs";

const aes = new Aes128();

// AES-128-CBC block size
const AES_BLOCK_SIZE = 16;
// We use 7 AES blocks = 112 bytes for ciphertext (fits in 6 fields with room to spare)
const CIPHERTEXT_SIZE = 112;
// Max plaintext: 112 - 1 (length byte) = 111 bytes
const MAX_PLAINTEXT_SIZE = 111;
// Bytes per field (leaving 1 byte for overflow safety)
const BYTES_PER_FIELD = 31;

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
 * @param plaintext - The delivery address or data to encrypt (max 111 bytes)
 * @param recipientPubKey - The recipient's public key (Point with x, y coordinates)
 * @returns Array of 8 field elements containing ephemeral pubkey + ciphertext
 */
export async function encryptDeliveryData(
  plaintext: string,
  recipientPubKey: { x: bigint; y: bigint; is_infinite: boolean }
): Promise<[Fr, Fr, Fr, Fr, Fr, Fr, Fr, Fr]> {
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
  const ephemeralPublicKey = await Grumpkin.mul(
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

  // 4. Prepare plaintext with length prefix, padded to 112 bytes
  // Format: [length (1 byte)] [data (up to 111 bytes)] [zero padding to 112 bytes]
  const paddedPlaintext = new Uint8Array(CIPHERTEXT_SIZE);
  paddedPlaintext[0] = plaintextBytes.length;
  paddedPlaintext.set(plaintextBytes, 1);
  // Rest is already zero-padded

  // 5. Encrypt (112 bytes in → 112 bytes out since it's exactly 7 blocks)
  // Note: encryptBufferCBC may add PKCS7 padding, making output 128 bytes
  // We handle this by only using the first 112 bytes
  const ciphertext = await aes.encryptBufferCBC(paddedPlaintext, iv, key);
  const cipherArray = Uint8Array.from(ciphertext);

  // 6. Pack into 8 field elements
  // Field 0-1: ephemeral public key
  // Fields 2-7: 112 bytes of ciphertext (distributed across 6 fields)

  // Helper to pack bytes into a field (31 bytes per field, at offset 1 in 32-byte buffer)
  const packBytesToField = (bytes: Uint8Array, offset: number, length: number): Fr => {
    const buffer = Buffer.alloc(32);
    const end = Math.min(offset + length, cipherArray.length);
    const actual = cipherArray.slice(offset, end);
    buffer.set(actual, 32 - length); // Right-align in buffer
    return Fr.fromBufferReduce(buffer);
  };

  // Pack ciphertext into 6 fields (31 bytes each, last one has remaining 19 bytes)
  // Total: 31 * 3 + 19 = 112 bytes
  const cipherField2 = packBytesToField(cipherArray, 0, 31);   // bytes 0-30
  const cipherField3 = packBytesToField(cipherArray, 31, 31);  // bytes 31-61
  const cipherField4 = packBytesToField(cipherArray, 62, 31);  // bytes 62-92
  const cipherField5 = packBytesToField(cipherArray, 93, 19);  // bytes 93-111 (19 bytes)
  const cipherField6 = new Fr(0n);  // Reserved for future use
  const cipherField7 = new Fr(0n);  // Reserved for future use

  return [
    new Fr(ephemeralPublicKey.x.toBigInt()),
    new Fr(ephemeralPublicKey.y.toBigInt()),
    cipherField2,
    cipherField3,
    cipherField4,
    cipherField5,
    cipherField6,
    cipherField7,
  ];
}

/**
 * Decrypt delivery data using ECIES.
 *
 * @param encryptedData - Array of 8 field elements from the contract
 * @param privateKey - The recipient's private key (GrumpkinScalar)
 * @returns The decrypted plaintext string
 */
export async function decryptDeliveryData(
  encryptedData: [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
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

  // 4. Extract ciphertext from fields 2-5
  const extractBytesFromField = (fieldValue: bigint, length: number): Uint8Array => {
    const buffer = new Fr(fieldValue).toBuffer();
    return Uint8Array.from(buffer).slice(32 - length);
  };

  // Reconstruct 112-byte ciphertext
  const ciphertext = new Uint8Array(CIPHERTEXT_SIZE);
  ciphertext.set(extractBytesFromField(encryptedData[2], 31), 0);   // 31 bytes
  ciphertext.set(extractBytesFromField(encryptedData[3], 31), 31);  // 31 bytes
  ciphertext.set(extractBytesFromField(encryptedData[4], 31), 62);  // 31 bytes
  ciphertext.set(extractBytesFromField(encryptedData[5], 19), 93);  // 19 bytes

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
  data: [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
): boolean {
  return data.every((v) => v === 0n);
}
