# Data collection mechanism

Scans a Bitcoin Core data directory via libbitcoinkernel and writes per-tx wallet
fingerprints to a DuckDB file, one scan per file.

```bash
# scan the last 1000 blocks from the tip down
cargo run --release -- start ~/.bitcoin scan.duckdb --chain mainnet --depth 1000

# omit --depth to scan to genesis

# a run that died picks up after its last commit
cargo run --release -- resume ~/.bitcoin scan.duckdb
```

`start` fixes the scan's chain and height range in the file and refuses a file
that already exists. `resume` reads them back, so it takes only the data directory
and the file. It refuses a scan that is already complete, a file written with a
different feature schema, and a data directory whose block at the resume point
has a different hash than the one recorded.

Rows are committed in batches of whole blocks, together with a `blocks` row per
block, so a killed run loses at most the work since its last commit (about
122,880 rows or 60 seconds).

## Tables

- `scan`: chain, start and end height, DuckDB version, start time.
- `blocks`: one row per done block with its hash, tx count (coinbase included),
  rows written and txs skipped.
- `txs`: `block_height`, `tx_index` (position in the block), then one column per
  feature. Coinbase txs are not written.

Rows are stored in walk order, so filtering on a `block_height` range reads only
that range:

```sql
SELECT * FROM txs WHERE block_height BETWEEN 800000 AND 809999;
```

`cargo run -- schema` prints the feature column schema on its own.

The `duckdb` crate is pinned to an exact version because a crashed run's WAL must
be replayed by the DuckDB version that wrote it.
