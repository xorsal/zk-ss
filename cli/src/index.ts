#!/usr/bin/env node
import { Command } from 'commander';
import { createPXEClient } from '@aztec/pxe';
import { getDeployedTestAccountsWallets } from '@aztec/accounts/testing/lazy';
import { Fr } from '@aztec/foundation/fields';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { Contract } from '@aztec/aztec.js/contracts';

// Contract artifact will be generated after compilation
// For now, we'll load it dynamically
const CONTRACT_ARTIFACT_PATH = '../contracts/secret_santa/target/secret_santa-SecretSanta.json';

const program = new Command();

program
  .name('zkss')
  .description('ZK Secret Santa CLI for Aztec')
  .version('0.1.0');

// Helper to get PXE client
async function getPXE(url: string = 'http://localhost:8080') {
  return createPXEClient(url);
}

// Helper to load contract artifact
async function loadArtifact() {
  const fs = await import('fs');
  const path = await import('path');
  const artifactPath = path.resolve(__dirname, CONTRACT_ARTIFACT_PATH);
  const artifactJson = fs.readFileSync(artifactPath, 'utf-8');
  return JSON.parse(artifactJson);
}

program
  .command('deploy')
  .description('Deploy the SecretSanta contract')
  .option('-p, --pxe <url>', 'PXE URL', 'http://localhost:8080')
  .option('-a, --admin <index>', 'Admin wallet index', '0')
  .action(async (options) => {
    try {
      const pxe = await getPXE(options.pxe);
      const wallets = await getDeployedTestAccountsWallets(pxe);
      const adminWallet = wallets[parseInt(options.admin)];

      console.log('Deploying SecretSanta contract...');
      console.log('Admin address:', adminWallet.getAddress().toString());

      const artifact = await loadArtifact();
      const contract = await Contract.deploy(adminWallet, artifact, [adminWallet.getAddress()])
        .send()
        .deployed();

      console.log('Contract deployed at:', contract.address.toString());
    } catch (error) {
      console.error('Error deploying contract:', error);
      process.exit(1);
    }
  });

program
  .command('register')
  .description('Register participants (admin only)')
  .requiredOption('-c, --contract <address>', 'Contract address')
  .requiredOption('--participants <addresses>', 'Comma-separated participant addresses')
  .option('-p, --pxe <url>', 'PXE URL', 'http://localhost:8080')
  .option('-a, --admin <index>', 'Admin wallet index', '0')
  .action(async (options) => {
    try {
      const pxe = await getPXE(options.pxe);
      const wallets = await getDeployedTestAccountsWallets(pxe);
      const adminWallet = wallets[parseInt(options.admin)];

      const artifact = await loadArtifact();
      const contract = await Contract.at(
        AztecAddress.fromString(options.contract),
        artifact,
        adminWallet
      );

      const participantAddrs = options.participants.split(',').map((a: string) =>
        AztecAddress.fromString(a.trim())
      );

      // Pad to 8 participants
      while (participantAddrs.length < 8) {
        participantAddrs.push(AztecAddress.ZERO);
      }

      const count = participantAddrs.filter((a: AztecAddress) => !a.isZero()).length;

      console.log(`Registering ${count} participants...`);

      const tx = await contract.methods.register_participants(
        ...participantAddrs,
        count
      ).send().wait();

      console.log('Participants registered. TX hash:', tx.txHash.toString());
    } catch (error) {
      console.error('Error registering participants:', error);
      process.exit(1);
    }
  });

program
  .command('advance')
  .description('Advance game state (admin only)')
  .requiredOption('-c, --contract <address>', 'Contract address')
  .option('-p, --pxe <url>', 'PXE URL', 'http://localhost:8080')
  .option('-a, --admin <index>', 'Admin wallet index', '0')
  .action(async (options) => {
    try {
      const pxe = await getPXE(options.pxe);
      const wallets = await getDeployedTestAccountsWallets(pxe);
      const adminWallet = wallets[parseInt(options.admin)];

      const artifact = await loadArtifact();
      const contract = await Contract.at(
        AztecAddress.fromString(options.contract),
        artifact,
        adminWallet
      );

      console.log('Advancing game state...');
      const tx = await contract.methods.advance_state().send().wait();
      console.log('State advanced. TX hash:', tx.txHash.toString());
    } catch (error) {
      console.error('Error advancing state:', error);
      process.exit(1);
    }
  });

program
  .command('submit-randomness')
  .description('Submit randomness and nullifier')
  .requiredOption('-c, --contract <address>', 'Contract address')
  .requiredOption('-n, --nullifier <field>', 'Your nullifier (Field)')
  .requiredOption('-r, --randomness <field>', 'Your randomness (Field)')
  .option('-p, --pxe <url>', 'PXE URL', 'http://localhost:8080')
  .option('-w, --wallet <index>', 'Wallet index', '0')
  .action(async (options) => {
    try {
      const pxe = await getPXE(options.pxe);
      const wallets = await getDeployedTestAccountsWallets(pxe);
      const wallet = wallets[parseInt(options.wallet)];

      const artifact = await loadArtifact();
      const contract = await Contract.at(
        AztecAddress.fromString(options.contract),
        artifact,
        wallet
      );

      const nullifier = Fr.fromString(options.nullifier);
      const randomness = Fr.fromString(options.randomness);

      console.log('Submitting randomness...');
      const tx = await contract.methods.submit_randomness(nullifier, randomness).send().wait();
      console.log('Randomness submitted. TX hash:', tx.txHash.toString());
    } catch (error) {
      console.error('Error submitting randomness:', error);
      process.exit(1);
    }
  });

program
  .command('disclose')
  .description('Disclose yourself as receiver and choose a sender')
  .requiredOption('-c, --contract <address>', 'Contract address')
  .requiredOption('-i, --sender-index <index>', 'Sender index to choose')
  .requiredOption('-n, --nullifier <field>', 'Your nullifier (to prove you are not choosing yourself)')
  .option('-p, --pxe <url>', 'PXE URL', 'http://localhost:8080')
  .option('-w, --wallet <index>', 'Wallet index', '0')
  .action(async (options) => {
    try {
      const pxe = await getPXE(options.pxe);
      const wallets = await getDeployedTestAccountsWallets(pxe);
      const wallet = wallets[parseInt(options.wallet)];

      const artifact = await loadArtifact();
      const contract = await Contract.at(
        AztecAddress.fromString(options.contract),
        artifact,
        wallet
      );

      const senderIndex = parseInt(options.senderIndex);
      const receiverNullifier = Fr.fromString(options.nullifier);

      console.log(`Disclosing as receiver, choosing sender ${senderIndex}...`);
      const tx = await contract.methods.disclose_receiver(senderIndex, receiverNullifier).send().wait();
      console.log('Disclosed. TX hash:', tx.txHash.toString());
    } catch (error) {
      console.error('Error disclosing:', error);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Get game status')
  .requiredOption('-c, --contract <address>', 'Contract address')
  .option('-p, --pxe <url>', 'PXE URL', 'http://localhost:8080')
  .option('-w, --wallet <index>', 'Wallet index', '0')
  .action(async (options) => {
    try {
      const pxe = await getPXE(options.pxe);
      const wallets = await getDeployedTestAccountsWallets(pxe);
      const wallet = wallets[parseInt(options.wallet)];

      const artifact = await loadArtifact();
      const contract = await Contract.at(
        AztecAddress.fromString(options.contract),
        artifact,
        wallet
      );

      const gameState = await contract.methods.get_game_state().simulate();
      const participantCount = await contract.methods.get_participant_count().simulate();
      const senderCount = await contract.methods.get_sender_count().simulate();
      const eventId = await contract.methods.get_event_id().simulate();
      const admin = await contract.methods.get_admin().simulate();

      const stateNames = ['Registration', 'Submission', 'Disclosure', 'Complete'];

      console.log('\n=== ZK Secret Santa Status ===');
      console.log('Game State:', stateNames[Number(gameState)] || 'Unknown');
      console.log('Event ID:', eventId.toString());
      console.log('Admin:', admin.toString());
      console.log('Participants:', Number(participantCount));
      console.log('Senders submitted:', Number(senderCount));
      console.log('');
    } catch (error) {
      console.error('Error getting status:', error);
      process.exit(1);
    }
  });

program
  .command('list-senders')
  .description('List all submitted senders')
  .requiredOption('-c, --contract <address>', 'Contract address')
  .option('-p, --pxe <url>', 'PXE URL', 'http://localhost:8080')
  .option('-w, --wallet <index>', 'Wallet index', '0')
  .action(async (options) => {
    try {
      const pxe = await getPXE(options.pxe);
      const wallets = await getDeployedTestAccountsWallets(pxe);
      const wallet = wallets[parseInt(options.wallet)];

      const artifact = await loadArtifact();
      const contract = await Contract.at(
        AztecAddress.fromString(options.contract),
        artifact,
        wallet
      );

      const senderCount = await contract.methods.get_sender_count().simulate();
      const count = Number(senderCount);

      console.log('\n=== Senders ===');
      for (let i = 0; i < count; i++) {
        const nullifier = await contract.methods.get_sender_nullifier(i).simulate();
        const randomness = await contract.methods.get_sender_randomness(i).simulate();
        const assignment = await contract.methods.get_assignment(i).simulate();

        console.log(`\nSender ${i}:`);
        console.log('  Nullifier:', nullifier.toString());
        console.log('  Randomness:', randomness.toString());
        console.log('  Assigned to:', assignment.isZero() ? '(not assigned)' : assignment.toString());
      }
      console.log('');
    } catch (error) {
      console.error('Error listing senders:', error);
      process.exit(1);
    }
  });

program
  .command('wallets')
  .description('List available test wallets')
  .option('-p, --pxe <url>', 'PXE URL', 'http://localhost:8080')
  .action(async (options) => {
    try {
      const pxe = await getPXE(options.pxe);
      const wallets = await getDeployedTestAccountsWallets(pxe);

      console.log('\n=== Available Wallets ===');
      wallets.forEach((wallet, i) => {
        console.log(`${i}: ${wallet.getAddress().toString()}`);
      });
      console.log('');
    } catch (error) {
      console.error('Error listing wallets:', error);
      process.exit(1);
    }
  });

program.parse();
