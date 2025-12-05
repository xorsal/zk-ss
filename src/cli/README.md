# ZK Secret Santa CLI

Interactive CLI for playing Secret Santa on Aztec with privacy-preserving gift exchange.

## Global Options

| Option | Description |
|--------|-------------|
| `--sandbox` | Connect to local sandbox (localhost:8080) |
| `--devnet` | Connect to Aztec devnet (devnet.aztec-labs.com) |
| `-p, --passphrase <pass>` | Wallet passphrase (skips interactive prompt) |

## Commands

### Setup & Info

**setup** - Deploy a new contract or connect to an existing one.
```bash
yarn cli --devnet -p "admin" setup
```

**info** - Show current configuration (network, contract address, game ID).
```bash
yarn cli info
```

**status** - View current game status including phase and slot information.
```bash
yarn cli -p "admin" status --game 1
```

### Admin Commands

**admin create** - Create a new Secret Santa game with participant limits.
```bash
yarn cli -p "admin" admin create --min 3 --max 10
```

**admin advance** - Advance the game to the next phase.
```bash
yarn cli -p "admin" admin advance --game 1
```

**admin status** - View detailed game status (alias for global status).
```bash
yarn cli -p "admin" admin status --game 1
```

### Player Commands

**enroll** - Enroll in a Secret Santa game during the Enrollment phase.
```bash
yarn cli -p "alice" enroll --game 1
```

**register** - Register as sender and claim a slot during Sender Registration phase.
```bash
yarn cli -p "alice" register --game 1 --slot 2
```

**claim** - Claim a slot as receiver during Receiver Claim phase (cannot claim your own slot).
```bash
yarn cli -p "alice" claim --game 1 --slot 3
```

**delivery** - View encrypted delivery data for your sender slot.
```bash
yarn cli -p "alice" delivery --game 1 --slot 2
```

## Game Flow

1. Admin creates game: `admin create`
2. Players enroll: `enroll`
3. Admin advances to Sender Registration: `admin advance`
4. Players register as senders: `register --slot N`
5. Admin advances to Receiver Claim: `admin advance`
6. Players claim receiver slots: `claim --slot M` (M != their sender slot)
7. Admin completes game: `admin advance`
8. Senders retrieve delivery data: `delivery`

## Configuration

Config is stored in `~/.zk-ss-config.json` and includes:
- `nodeUrl` - Aztec node URL
- `network` - Current network (sandbox/devnet)
- `contractAddress` - Deployed contract address
- `currentGameId` - Active game ID
