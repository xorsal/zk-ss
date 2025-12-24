# ZK Secret Santa

Privacy-preserving Secret Santa on Aztec. Nobody knows who sends to whom.

## Game Phases

1. **JOIN** - Players enroll in the game
2. **CLAIM** - Players pick a sender slot (register)
3. **MATCH** - Players claim as receiver (slot auto-assigned via cyclic permutation)
4. **REVEAL** - Game complete, senders can view their recipient's delivery address

## Cyclic Slot Assignment

To guarantee everyone gets matched (no deadlocks), the MATCH phase uses cyclic permutation:

```
Your receiver slot = (your_sender_slot % participant_count) + 1
```

Example with 3 players:
- Alice (slot 1) -> receives from slot 2 (Bob)
- Bob (slot 2) -> receives from slot 3 (Carol)
- Carol (slot 3) -> receives from slot 1 (Alice)

This forms a cycle: Alice sends to Carol, Carol sends to Bob, Bob sends to Alice.

## Install

```bash
git clone <REPO>
cd zk-ss
yarn install
yarn ccc
```

## Player Commands

### Setup (one-time)

```bash
yarn cli --next-devnet setup --connect <CONTRACT_ADDRESS>
export ZK_PASSPHRASE="your-secret-phrase"
export GAME=<GAME_ID>
```

### Play (automatic flow)

```bash
yarn cli --next-devnet -p $ZK_PASSPHRASE enroll --game $GAME
```

The CLI polls and guides you through all phases automatically.

### Manual Commands

```bash
yarn cli --next-devnet -p $ZK_PASSPHRASE enroll --game $GAME        # Join a game
yarn cli --next-devnet -p $ZK_PASSPHRASE register --slot <N>        # Pick a sender slot
yarn cli --next-devnet -p $ZK_PASSPHRASE claim --sender-slot <N>    # Claim as receiver (auto-assigned)
yarn cli --next-devnet -p $ZK_PASSPHRASE delivery --slot <N>        # View your recipient's address
```

### Utility

```bash
yarn cli info                      # Show config
yarn cli --next-devnet status      # Game status
```

## Admin Commands

### Deploy & Create Game

```bash
yarn cli --next-devnet setup --full-deploy
yarn cli --next-devnet admin create --min 3 --max 3
```

### Manage Game

```bash
export ZK_PASSPHRASE="secret-santa-admin"
yarn cli --next-devnet -p $ZK_PASSPHRASE status --game $GAME
yarn cli --next-devnet -p $ZK_PASSPHRASE admin advance --game $GAME
```
