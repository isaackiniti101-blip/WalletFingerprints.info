mod analysis;

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant};

use analysis::normalize::{INT_COLUMNS, NormalizedTx};
use analysis::{
    BlockTxContext, analyze_tx, bitcoin_tx_from_bytes, normalize_tx, prevouts_from_kernel_coins,
    schema, schema_ref,
};
use bitcoinkernel::{
    BlockTreeEntry, ChainType, ChainstateManager, ChainstateManagerBuilder, Context,
    ContextBuilder, prelude::*,
};
use clap::{Parser, Subcommand, ValueEnum};
use duckdb::arrow::array::{ArrayRef, BooleanArray, Int32Array};
use duckdb::arrow::datatypes::{DataType, Field, Schema};
use duckdb::arrow::record_batch::RecordBatch;
use duckdb::{Connection, params};
use polars::prelude::*;
use rayon::prelude::*;

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CliChainType {
    Mainnet,
    Testnet,
    Signet,
    Regtest,
}

impl From<CliChainType> for ChainType {
    fn from(value: CliChainType) -> Self {
        match value {
            CliChainType::Mainnet => ChainType::Mainnet,
            CliChainType::Testnet => ChainType::Testnet,
            CliChainType::Signet => ChainType::Signet,
            CliChainType::Regtest => ChainType::Regtest,
        }
    }
}

/// How often the scan prints a progress line. A full-chain walk runs for hours,
/// so silence is indistinguishable from a hang.
const PROGRESS_INTERVAL: Duration = Duration::from_secs(5);

/// Rows buffered per Parquet row group. At ~123 boolean columns this is on the
/// order of 120MB of staging memory, near the usual Parquet row-group target.
const DEFAULT_BATCH_SIZE: usize = 1_000_000;

/// Rows buffered before a commit. Matches DuckDB's row-group size, since each
/// commit closes the open row group and smaller commits leave them half full.
const COMMIT_ROWS: usize = 122_880;

/// Longest stretch between commits. Early blocks are coinbase-only and write no
/// rows, so the row threshold alone could leave hours of work uncommitted.
const COMMIT_INTERVAL: Duration = Duration::from_secs(60);

/// Bitcoin tx fingerprint scanner and feature normalizer.
#[derive(Debug, Parser)]
#[command(name = "kernel-playground", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Walk blocks from tip, analyze each tx, and write a normalized Parquet feature matrix.
    Scan(ScanArgs),
    /// Print the normalized feature column schema as JSON.
    Schema,
}

#[derive(Debug, Parser)]
struct ScanArgs {
    /// Path to a Bitcoin Core data directory readable by libbitcoinkernel.
    data_dir: String,
    /// How many blocks to walk back from the tip (inclusive of tip).
    /// Omit to scan all the way to genesis.
    #[arg(long, conflicts_with_all = ["start_height", "end_height"])]
    depth: Option<u32>,
    /// Lowest block height to scan (inclusive). Defaults to genesis.
    #[arg(long)]
    start_height: Option<u32>,
    /// Highest block height to scan (inclusive). Defaults to the tip.
    ///
    /// With `--start-height`, this makes a run restartable: a walk that died at
    /// height N resumes with `--end-height N`.
    #[arg(long)]
    end_height: Option<u32>,
    /// Network the data directory belongs to.
    #[arg(long, value_enum, default_value_t = CliChainType::Regtest)]
    chain: CliChainType,
    /// Optional override for the blocks directory (defaults to `<data_dir>/blocks`).
    #[arg(long)]
    blocks_dir: Option<String>,
    /// Destination Parquet file for the feature matrix.
    #[arg(short, long)]
    output: PathBuf,
    /// Optional path to write the column schema JSON.
    #[arg(long)]
    schema_out: Option<PathBuf>,
    /// Rows per Parquet row group. Caps how much is held in memory at once.
    #[arg(long, default_value_t = DEFAULT_BATCH_SIZE)]
    batch_size: usize,
}

fn main() -> ExitCode {
    if let Err(err) = run() {
        eprintln!("error: {err}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

fn run() -> Result<(), String> {
    match Cli::parse().command {
        Command::Scan(args) => run_scan(args),
        Command::Schema => {
            let schema = schema();
            println!(
                "{}",
                serde_json::to_string_pretty(&schema)
                    .map_err(|e| format!("serialize schema: {e}"))?
            );
            Ok(())
        }
    }
}

fn create_context(chain: ChainType) -> Result<Arc<Context>, String> {
    ContextBuilder::new()
        .chain_type(chain)
        .build()
        .map(Arc::new)
        .map_err(|e| format!("failed to build kernel context: {e}"))
}

fn run_scan(args: ScanArgs) -> Result<(), String> {
    if matches!(args.depth, Some(0)) {
        return Err("depth must be >= 1 (omit --depth to scan to genesis)".into());
    }

    if args.batch_size == 0 {
        return Err("--batch-size must be >= 1".into());
    }
    if let Some(path) = &args.schema_out {
        write_schema(path)?;
    }

    // Open the sink before spending minutes importing blocks, so a bad output
    // path fails immediately rather than after the walk.
    let columns = &schema_ref().columns;
    let mut sink: Box<dyn RowSink> =
        Box::new(ParquetSink::new(&args.output, columns, args.batch_size)?);

    let context = create_context(args.chain.into())?;
    let blocks_dir = args
        .blocks_dir
        .unwrap_or_else(|| format!("{}/blocks", args.data_dir));

    let chainman = ChainstateManagerBuilder::new(&context, &args.data_dir, &blocks_dir)
        .map_err(|e| format!("chainstate manager builder: {e}"))?
        .build()
        .map_err(|e| format!("chainstate manager build: {e}"))?;

    chainman
        .import_blocks()
        .map_err(|e| format!("import_blocks: {e}"))?;

    let tip = chainman
        .best_entry()
        .ok_or_else(|| "no best block entry (empty chain?)".to_string())?;
    let tip_height = tip.height();

    let end_height = match args.end_height {
        Some(end) => {
            let end = end as i32;
            if end > tip_height {
                return Err(format!(
                    "--end-height {end} is above the tip at {tip_height}"
                ));
            }
            end
        }
        None => tip_height,
    };
    let start_height = match (args.start_height, args.depth) {
        (Some(start), _) => start as i32,
        (None, Some(depth)) => {
            let chain_len = tip_height as i64 + 1;
            if depth as i64 > chain_len {
                return Err(format!(
                    "--depth {depth} is longer than the chain ({chain_len} blocks)"
                ));
            }
            tip_height - (depth as i32 - 1)
        }
        (None, None) => 0,
    };
    if start_height > end_height {
        return Err(format!(
            "--start-height {start_height} is above --end-height {end_height}"
        ));
    }

    // Walk down from the tip to the requested range. `prev()` only follows the
    // block index, so skipping ahead of the range costs no block reads.
    let mut entry = tip;
    while entry.height() > end_height {
        entry = entry
            .prev()
            .ok_or_else(|| format!("chain ended before reaching height {end_height}"))?;
    }

    eprintln!(
        "scanning {} block(s) from height {} to {} ({})",
        end_height.saturating_sub(start_height) + 1,
        start_height,
        end_height,
        entry.block_hash()
    );

    let total_blocks = (end_height.saturating_sub(start_height) + 1) as u64;
    let mut progress = Progress::new(total_blocks);

    loop {
        let height = entry.height();
        if height < start_height {
            break;
        }

        let outcome = analyze_block(&chainman, &entry, sink.as_mut())?;
        sink.end_block(&outcome)?;
        progress.record(height, &outcome);

        if height == 0 {
            break;
        }
        entry = match entry.prev() {
            Some(prev) => prev,
            None => break,
        };
    }

    let rows = sink.finish()?;
    progress.finish();
    eprintln!("wrote {} ({rows} rows)", args.output.display());
    Ok(())
}

/// Periodic scan progress on stderr, plus a skipped-tx tally.
///
/// Skipped transactions are counted rather than printed one by one: a bad run
/// could otherwise emit millions of lines, and the analysis now runs on rayon
/// threads where those prints would interleave.
struct Progress {
    total_blocks: u64,
    blocks: u64,
    rows: u64,
    skipped: u64,
    first_error: Option<String>,
    started: Instant,
    last_print: Instant,
}

impl Progress {
    fn new(total_blocks: u64) -> Self {
        let now = Instant::now();
        Self {
            total_blocks,
            blocks: 0,
            rows: 0,
            skipped: 0,
            first_error: None,
            started: now,
            last_print: now,
        }
    }

    fn record(&mut self, height: i32, outcome: &BlockOutcome) {
        self.blocks += 1;
        self.rows += outcome.rows;
        self.skipped += outcome.skipped;
        if self.first_error.is_none() {
            self.first_error.clone_from(&outcome.first_error);
        }

        if self.last_print.elapsed() >= PROGRESS_INTERVAL {
            self.print(height);
            self.last_print = Instant::now();
        }
    }

    fn print(&self, height: i32) {
        let elapsed = self.started.elapsed().as_secs_f64();
        let bps = if elapsed > 0.0 {
            self.blocks as f64 / elapsed
        } else {
            0.0
        };
        // Blocks remaining at the current rate; the walk runs tip-to-genesis, so
        // `height` alone does not say how much is left.
        let eta = if bps > 0.0 {
            format_duration(((self.total_blocks - self.blocks) as f64 / bps) as u64)
        } else {
            "?".to_string()
        };
        eprintln!(
            "  height {height}: {}/{} blocks, {} rows, {:.1} blocks/s, eta {eta}",
            self.blocks, self.total_blocks, self.rows, bps
        );
    }

    fn finish(&self) {
        let elapsed = self.started.elapsed().as_secs_f64();
        eprintln!(
            "scanned {} block(s), {} tx in {} ({:.1} blocks/s)",
            self.blocks,
            self.rows,
            format_duration(elapsed as u64),
            if elapsed > 0.0 {
                self.blocks as f64 / elapsed
            } else {
                0.0
            }
        );
        if self.skipped > 0 {
            eprintln!(
                "warn: skipped {} tx that failed analysis; first was {}",
                self.skipped,
                self.first_error.as_deref().unwrap_or("unknown")
            );
        }
    }
}

fn format_duration(secs: u64) -> String {
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    if h > 0 {
        format!("{h}h{m:02}m")
    } else if m > 0 {
        format!("{m}m{s:02}s")
    } else {
        format!("{s}s")
    }
}

/// Destination for normalized feature rows.
///
/// One implementation per output format; `scan` holds it boxed so adding a
/// format is a new impl rather than a change to the block walk.
trait RowSink {
    /// Accept one row. `columns` is the feature schema `norm.x` is aligned with.
    fn push(
        &mut self,
        tx_index: i32,
        norm: &NormalizedTx,
        columns: &[String],
    ) -> Result<(), String>;

    /// Mark `block` done. Every row pushed since the previous call belongs to it.
    fn end_block(&mut self, block: &BlockOutcome) -> Result<(), String>;

    /// Flush anything buffered and close the output, returning rows written.
    fn finish(self: Box<Self>) -> Result<u64, String>;
}

/// The heights a scan covers, fixed when it starts.
#[derive(Debug, Clone, Copy)]
struct ScanRange {
    chain: CliChainType,
    start_height: i32,
    end_height: i32,
}

/// What a resume needs from an existing scan file.
#[derive(Debug)]
struct ResumeState {
    range: ScanRange,
    /// Lowest done block and its hash; `None` if no block was committed yet.
    lowest_done: Option<(i32, String)>,
}

fn write_schema(path: &Path) -> Result<(), String> {
    let mut f = File::create(path).map_err(|e| format!("schema_out: {e}"))?;
    writeln!(
        f,
        "{}",
        serde_json::to_string_pretty(schema_ref()).map_err(|e| format!("schema json: {e}"))?
    )
    .map_err(|e| format!("schema write: {e}"))
}

/// Column-major staging buffer for the next Parquet row group or `txs` commit.
struct RowBuffer {
    block_height: Vec<i32>,
    tx_index: Vec<i32>,
    int_names: Vec<String>,
    int_cols: Vec<Vec<i32>>,
    bool_names: Vec<String>,
    bool_cols: Vec<Vec<bool>>,
}

impl RowBuffer {
    fn new(columns: &[String]) -> Self {
        let (int_names, bool_names): (Vec<String>, Vec<String>) = columns
            .iter()
            .cloned()
            .partition(|name| INT_COLUMNS.contains(&name.as_str()));
        let int_cols = vec![Vec::new(); int_names.len()];
        let bool_cols = vec![Vec::new(); bool_names.len()];
        Self {
            block_height: Vec::new(),
            tx_index: Vec::new(),
            int_names,
            int_cols,
            bool_names,
            bool_cols,
        }
    }

    fn len(&self) -> usize {
        self.block_height.len()
    }

    /// Polars schema of the frames produced by [`RowBuffer::take_frame`].
    ///
    /// Declared up front so every row group in the file shares one schema.
    fn polars_schema(&self) -> polars::prelude::Schema {
        // The arrow imports used by `take_batch` shadow polars' names.
        use polars::prelude::{DataType, Schema};
        let mut fields: Vec<(PlSmallStr, DataType)> = vec![
            ("block_height".into(), DataType::Int32),
            ("tx_index".into(), DataType::Int32),
        ];
        fields.extend(
            self.int_names
                .iter()
                .map(|name| (name.as_str().into(), DataType::Int32)),
        );
        fields.extend(
            self.bool_names
                .iter()
                .map(|name| (name.as_str().into(), DataType::Boolean)),
        );
        Schema::from_iter(fields)
    }

    /// `txs` columns as (name, DuckDB type), in table order.
    ///
    /// The appender maps record-batch columns by position, so this order must
    /// match [`RowBuffer::take_batch`].
    fn sql_columns(&self) -> Vec<(String, &'static str)> {
        let mut cols = vec![
            ("block_height".to_string(), "INTEGER"),
            ("tx_index".to_string(), "INTEGER"),
        ];
        cols.extend(self.int_names.iter().map(|n| (n.clone(), "INTEGER")));
        cols.extend(self.bool_names.iter().map(|n| (n.clone(), "BOOLEAN")));
        cols
    }

    fn push(
        &mut self,
        tx_index: i32,
        norm: &NormalizedTx,
        columns: &[String],
    ) -> Result<(), String> {
        if norm.x.len() != columns.len() {
            return Err(format!(
                "feature width {} != schema {}",
                norm.x.len(),
                columns.len()
            ));
        }
        self.block_height.push(norm.block_height);
        self.tx_index.push(tx_index);

        let (mut int_i, mut bool_i) = (0, 0);
        for (name, value) in columns.iter().zip(norm.x.iter()) {
            if INT_COLUMNS.contains(&name.as_str()) {
                self.int_cols[int_i].push(*value as i32);
                int_i += 1;
            } else {
                self.bool_cols[bool_i].push(*value != 0.0);
                bool_i += 1;
            }
        }
        Ok(())
    }

    /// Drain the buffered rows into a frame, leaving the buffer empty and reusable.
    ///
    /// Column order must match [`RowBuffer::polars_schema`].
    fn take_frame(&mut self) -> Result<DataFrame, String> {
        let mut cols: Vec<Column> = vec![
            Series::new(
                "block_height".into(),
                std::mem::take(&mut self.block_height),
            )
            .into(),
            Series::new("tx_index".into(), std::mem::take(&mut self.tx_index)).into(),
        ];
        for (name, values) in self.int_names.iter().zip(self.int_cols.iter_mut()) {
            cols.push(Series::new(name.as_str().into(), std::mem::take(values)).into());
        }
        for (name, values) in self.bool_names.iter().zip(self.bool_cols.iter_mut()) {
            cols.push(Series::new(name.as_str().into(), std::mem::take(values)).into());
        }
        DataFrame::new(cols).map_err(|e| format!("dataframe: {e}"))
    }

    /// Drain the buffered rows into a record batch, leaving the buffer empty and reusable.
    fn take_batch(&mut self) -> Result<RecordBatch, String> {
        let mut arrays: Vec<ArrayRef> = vec![
            Arc::new(Int32Array::from(std::mem::take(&mut self.block_height))),
            Arc::new(Int32Array::from(std::mem::take(&mut self.tx_index))),
        ];
        for values in &mut self.int_cols {
            arrays.push(Arc::new(Int32Array::from(std::mem::take(values))));
        }
        for values in &mut self.bool_cols {
            arrays.push(Arc::new(BooleanArray::from(std::mem::take(values))));
        }
        let fields: Vec<Field> = self
            .sql_columns()
            .into_iter()
            .map(|(name, ty)| {
                let ty = if ty == "BOOLEAN" {
                    DataType::Boolean
                } else {
                    DataType::Int32
                };
                Field::new(name, ty, false)
            })
            .collect();
        RecordBatch::try_new(Arc::new(Schema::new(fields)), arrays)
            .map_err(|e| format!("record batch: {e}"))
    }
}

/// Streams feature rows to Parquet one row group at a time.
///
/// Only `batch_size` rows are held in memory, so a full-chain walk costs a
/// bounded amount of RAM regardless of how many transactions it visits.
struct ParquetSink {
    writer: BatchedWriter<BufWriter<File>>,
    rows: RowBuffer,
    batch_size: usize,
    written: u64,
}

impl ParquetSink {
    fn new(path: &Path, columns: &[String], batch_size: usize) -> Result<Self, String> {
        let rows = RowBuffer::new(columns);
        let schema = rows.polars_schema();
        let file = File::create(path).map_err(|e| format!("create {}: {e}", path.display()))?;
        let writer = ParquetWriter::new(BufWriter::new(file))
            .batched(&schema)
            .map_err(|e| format!("parquet writer: {e}"))?;
        Ok(Self {
            writer,
            rows,
            batch_size,
            written: 0,
        })
    }

    /// Write the buffered rows as one row group.
    fn flush(&mut self) -> Result<(), String> {
        let n = self.rows.len();
        if n == 0 {
            return Ok(());
        }
        let frame = self.rows.take_frame()?;
        self.writer
            .write_batch(&frame)
            .map_err(|e| format!("parquet row group: {e}"))?;
        self.written += n as u64;
        Ok(())
    }
}

impl RowSink for ParquetSink {
    fn push(
        &mut self,
        tx_index: i32,
        norm: &NormalizedTx,
        columns: &[String],
    ) -> Result<(), String> {
        self.rows.push(tx_index, norm, columns)?;
        if self.rows.len() >= self.batch_size {
            self.flush()?;
        }
        Ok(())
    }

    /// Row groups are sized by row count, not blocks.
    fn end_block(&mut self, _block: &BlockOutcome) -> Result<(), String> {
        Ok(())
    }

    /// Flush the tail and write the file footer.
    ///
    /// With no rows at all this still emits a valid empty file carrying the schema.
    fn finish(mut self: Box<Self>) -> Result<u64, String> {
        self.flush()?;
        self.writer
            .finish()
            .map_err(|e| format!("parquet footer: {e}"))?;
        Ok(self.written)
    }
}

/// Writes a scan to a DuckDB file, committing whole blocks at a time.
///
/// A block's `blocks` row commits in the same transaction as its `txs` rows, so
/// a block is done exactly when its rows are durable, and a killed run loses
/// only the uncommitted tail.
struct DuckDbSink {
    conn: Connection,
    rows: RowBuffer,
    blocks: Vec<BlockOutcome>,
    commit_rows: usize,
    last_commit: Instant,
    written: u64,
}

/// Quote a column name; some features contain `|`.
fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

impl DuckDbSink {
    /// Create `path` holding a new, empty scan over `range`.
    fn create(path: &Path, range: &ScanRange, columns: &[String]) -> Result<Self, String> {
        if path.exists() {
            return Err(format!("{} already exists", path.display()));
        }
        let conn = Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
        let rows = RowBuffer::new(columns);
        let txs_columns = rows
            .sql_columns()
            .iter()
            .map(|(name, ty)| format!("{} {ty} NOT NULL", ident(name)))
            .collect::<Vec<_>>()
            .join(", ");
        let chain = range
            .chain
            .to_possible_value()
            .expect("chain variants are not skipped");
        // The scan row commits on its own, so a run killed before its first
        // block commit still leaves a resumable file.
        conn.execute_batch(&format!(
            "BEGIN;
             CREATE TABLE scan (
                 chain VARCHAR NOT NULL,
                 start_height INTEGER NOT NULL,
                 end_height INTEGER NOT NULL,
                 duckdb_version VARCHAR NOT NULL,
                 started_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
             );
             CREATE TABLE blocks (
                 height INTEGER NOT NULL,
                 hash VARCHAR NOT NULL,
                 tx_count INTEGER NOT NULL,
                 \"rows\" INTEGER NOT NULL,
                 skipped INTEGER NOT NULL
             );
             CREATE TABLE txs ({txs_columns});
             INSERT INTO scan (chain, start_height, end_height, duckdb_version)
                 VALUES ('{}', {}, {}, version());
             COMMIT;",
            chain.get_name(),
            range.start_height,
            range.end_height
        ))
        .map_err(|e| format!("create tables: {e}"))?;
        Ok(Self::with(conn, rows))
    }

    /// Open the unfinished scan in `path` for resuming.
    ///
    /// Refuses a file whose `txs` columns differ from `columns`, whose done
    /// blocks are not one contiguous run down from the end height, or whose
    /// scan is already complete.
    fn open(path: &Path, columns: &[String]) -> Result<(Self, ResumeState), String> {
        // `Connection::open` would silently create a fresh file.
        if !path.exists() {
            return Err(format!(
                "{} does not exist; start a scan with `start`",
                path.display()
            ));
        }
        let conn = Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
        let rows = RowBuffer::new(columns);

        let (chain, start_height, end_height): (String, i32, i32) = conn
            .query_row(
                "SELECT chain, start_height, end_height FROM scan",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| format!("read scan: {e}"))?;
        let chain = CliChainType::from_str(&chain, false)
            .map_err(|e| format!("stored chain {chain:?}: {e}"))?;
        let range = ScanRange {
            chain,
            start_height,
            end_height,
        };

        let mut stmt = conn
            .prepare(
                "SELECT column_name, data_type FROM information_schema.columns
                 WHERE table_name = 'txs' ORDER BY ordinal_position",
            )
            .map_err(|e| format!("read txs columns: {e}"))?;
        let stored: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .and_then(|it| it.collect())
            .map_err(|e| format!("read txs columns: {e}"))?;
        drop(stmt);
        let expected = rows.sql_columns();
        let same = stored.len() == expected.len()
            && stored
                .iter()
                .zip(&expected)
                .all(|((name, ty), (want_name, want_ty))| name == want_name && ty == want_ty);
        if !same {
            return Err(format!(
                "{} was written with a different feature schema ({} columns, this binary has {}); start a new scan file",
                path.display(),
                stored.len(),
                expected.len()
            ));
        }

        let (min, max, count, distinct): (Option<i32>, Option<i32>, i64, i64) = conn
            .query_row(
                "SELECT min(height), max(height), count(*), count(DISTINCT height) FROM blocks",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|e| format!("read blocks: {e}"))?;
        let lowest_done = match (min, max) {
            (Some(min), Some(max)) => {
                let contiguous = max == end_height
                    && count == distinct
                    && count == (end_height - min + 1) as i64;
                if !contiguous {
                    return Err(format!(
                        "{}: done blocks are not one contiguous run down from height {end_height}",
                        path.display()
                    ));
                }
                if min == start_height {
                    return Err(format!("{}: scan is already complete", path.display()));
                }
                let hash: String = conn
                    .query_row("SELECT hash FROM blocks WHERE height = ?", [min], |r| {
                        r.get(0)
                    })
                    .map_err(|e| format!("read block {min}: {e}"))?;
                Some((min, hash))
            }
            _ => None,
        };

        Ok((Self::with(conn, rows), ResumeState { range, lowest_done }))
    }

    fn with(conn: Connection, rows: RowBuffer) -> Self {
        Self {
            conn,
            rows,
            blocks: Vec::new(),
            commit_rows: COMMIT_ROWS,
            last_commit: Instant::now(),
            written: 0,
        }
    }

    /// Commit buffered rows together with the blocks they came from.
    fn commit(&mut self) -> Result<(), String> {
        if self.blocks.is_empty() {
            return Ok(());
        }
        let n = self.rows.len();
        let batch = self.rows.take_batch()?;
        // On error the transaction stays open and is discarded when the
        // connection drops, so a failed commit leaves nothing behind.
        self.conn
            .execute_batch("BEGIN")
            .map_err(|e| format!("begin: {e}"))?;
        {
            let mut txs = self
                .conn
                .appender("txs")
                .map_err(|e| format!("txs appender: {e}"))?;
            if n > 0 {
                txs.append_record_batch(batch)
                    .map_err(|e| format!("append txs: {e}"))?;
            }
            // Drop discards flush errors, so flush explicitly.
            txs.flush().map_err(|e| format!("flush txs: {e}"))?;

            let mut blocks = self
                .conn
                .appender("blocks")
                .map_err(|e| format!("blocks appender: {e}"))?;
            for b in self.blocks.drain(..) {
                blocks
                    .append_row(params![
                        b.height,
                        b.hash,
                        b.tx_count as i32,
                        b.rows as i32,
                        b.skipped as i32
                    ])
                    .map_err(|e| format!("append block {}: {e}", b.height))?;
            }
            blocks.flush().map_err(|e| format!("flush blocks: {e}"))?;
        }
        self.conn
            .execute_batch("COMMIT")
            .map_err(|e| format!("commit: {e}"))?;
        self.written += n as u64;
        self.last_commit = Instant::now();
        Ok(())
    }
}

impl RowSink for DuckDbSink {
    fn push(
        &mut self,
        tx_index: i32,
        norm: &NormalizedTx,
        columns: &[String],
    ) -> Result<(), String> {
        self.rows.push(tx_index, norm, columns)
    }

    fn end_block(&mut self, block: &BlockOutcome) -> Result<(), String> {
        self.blocks.push(block.clone());
        if self.rows.len() >= self.commit_rows || self.last_commit.elapsed() >= COMMIT_INTERVAL {
            self.commit()?;
        }
        Ok(())
    }

    /// Commit the tail and checkpoint, leaving a single file with no WAL.
    fn finish(mut self: Box<Self>) -> Result<u64, String> {
        self.commit()?;
        self.conn
            .execute_batch("CHECKPOINT")
            .map_err(|e| format!("checkpoint: {e}"))?;
        Ok(self.written)
    }
}

fn analyze_block(
    chainman: &ChainstateManager,
    entry: &BlockTreeEntry<'_>,
    sink: &mut dyn RowSink,
) -> Result<BlockOutcome, String> {
    let height = entry.height();
    let block_hash = entry.block_hash().to_string();
    let block = chainman
        .read_block_data(entry)
        .map_err(|e| format!("read_block_data at {height}: {e}"))?;

    let spent = if height == 0 {
        None
    } else {
        Some(
            chainman
                .read_spent_outputs(entry)
                .map_err(|e| format!("read_spent_outputs at {height}: {e}"))?,
        )
    };

    let mut txs = Vec::with_capacity(block.transaction_count());
    for (tx_index, kernel_tx) in block.transactions().enumerate() {
        let bytes = kernel_tx
            .consensus_encode()
            .map_err(|e| format!("tx encode {block_hash}:{tx_index}: {e}"))?;
        let tx = bitcoin_tx_from_bytes(&bytes)?;
        txs.push(tx);
    }

    // Kernel handles are FFI-bound and not `Send`, so prevouts are pulled out
    // here, on this thread, before any parallel work starts.
    let mut prevouts: Vec<Vec<bitcoin::TxOut>> = Vec::with_capacity(txs.len());
    for (tx_index, tx) in txs.iter().enumerate() {
        if tx.is_coinbase() {
            prevouts.push(Vec::new());
            continue;
        }
        let spent = spent
            .as_ref()
            .ok_or_else(|| format!("missing spent outputs for non-genesis block {height}"))?;
        let spent_index = tx_index
            .checked_sub(1)
            .ok_or_else(|| format!("non-coinbase tx at index 0 in block {height}"))?;
        let tx_spent = spent
            .transaction_spent_outputs(spent_index)
            .map_err(|e| format!("tx spent outputs {block_hash}:{tx_index}: {e}"))?;

        let coin_pairs: Vec<(i64, Vec<u8>)> = tx_spent
            .coins()
            .map(|coin| {
                let out = coin.output();
                (out.value(), out.script_pubkey().to_bytes())
            })
            .collect();

        if coin_pairs.len() != tx.input.len() {
            return Err(format!(
                "prevout count mismatch at {block_hash}:{tx_index}: {} coins vs {} inputs",
                coin_pairs.len(),
                tx.input.len()
            ));
        }
        prevouts.push(prevouts_from_kernel_coins(coin_pairs)?);
    }

    let block_ctxs = build_cpfp_context(&txs);

    // Analysis is pure over owned data, so it fans out across the block's txs.
    // `collect` keeps rows in block order. Coinbase txs are built by pool
    // software rather than a wallet, so they are not part of the output.
    let rows: Vec<Result<(i32, NormalizedTx), String>> = txs
        .par_iter()
        .zip(prevouts.par_iter())
        .zip(block_ctxs.par_iter())
        .enumerate()
        .filter(|(_, ((tx, _), _))| !tx.is_coinbase())
        .map(|(tx_index, ((tx, prevouts), block_ctx))| {
            match analyze_tx(tx, prevouts, height, &block_hash, block_ctx) {
                Ok(analysis) => Ok((tx_index as i32, normalize_tx(&analysis))),
                // Reported back to the caller rather than printed here: this
                // closure runs on rayon threads, where prints interleave.
                Err(err) => Err(format!("tx {block_hash}:{tx_index}: {err}")),
            }
        })
        .collect();

    let mut outcome = BlockOutcome {
        height,
        tx_count: txs.len() as u64,
        hash: block_hash,
        ..Default::default()
    };
    for row in &rows {
        match row {
            Ok((tx_index, norm)) => {
                sink.push(*tx_index, norm, &schema_ref().columns)?;
                outcome.rows += 1;
            }
            Err(err) => {
                outcome.skipped += 1;
                if outcome.first_error.is_none() {
                    outcome.first_error = Some(err.clone());
                }
            }
        }
    }

    Ok(outcome)
}

/// What one block contributed to the scan.
#[derive(Debug, Default, Clone)]
struct BlockOutcome {
    height: i32,
    hash: String,
    /// Every tx in the block, coinbase included.
    tx_count: u64,
    rows: u64,
    skipped: u64,
    /// One sample error, so a run can show *why* txs are being skipped without
    /// emitting a line per failure.
    first_error: Option<String>,
}

fn build_cpfp_context(txs: &[bitcoin::Transaction]) -> Vec<BlockTxContext> {
    let txid_to_index: HashMap<bitcoin::Txid, usize> = txs
        .iter()
        .enumerate()
        .map(|(i, tx)| (tx.compute_txid(), i))
        .collect();

    let mut parents_with_child: HashSet<usize> = HashSet::new();
    let mut children_with_parent: HashSet<usize> = HashSet::new();

    for (child_idx, tx) in txs.iter().enumerate() {
        if tx.is_coinbase() {
            continue;
        }
        for input in &tx.input {
            if let Some(&parent_idx) = txid_to_index.get(&input.previous_output.txid)
                && parent_idx < child_idx
            {
                parents_with_child.insert(parent_idx);
                children_with_parent.insert(child_idx);
            }
        }
    }

    (0..txs.len())
        .map(|i| BlockTxContext {
            spends_same_block_parent: children_with_parent.contains(&i),
            has_same_block_child: parents_with_child.contains(&i),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic normalized row; `x` must be schema-wide.
    fn row(height: i32, i: usize, columns: &[String]) -> NormalizedTx {
        let x = columns
            .iter()
            .enumerate()
            .map(|(j, name)| {
                if name == "fp_version" {
                    2.0
                } else if (i + j).is_multiple_of(3) {
                    1.0
                } else {
                    0.0
                }
            })
            .collect();
        NormalizedTx {
            block_height: height,
            x,
        }
    }

    /// Fresh path for one test's scan file; tests run in parallel, so each uses its own name.
    fn db_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("kp_duckdb_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{name}.duckdb"));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("duckdb.wal"));
        path
    }

    fn range(start_height: i32, end_height: i32) -> ScanRange {
        ScanRange {
            chain: CliChainType::Regtest,
            start_height,
            end_height,
        }
    }

    /// Rows per synthetic block: some blocks write none, like coinbase-only ones.
    fn rows_in(height: i32) -> usize {
        (height % 3) as usize
    }

    /// Feed blocks `from` down to `to`, the way `walk` drives the sink.
    fn feed(sink: &mut DuckDbSink, from: i32, to: i32) {
        let columns = &schema_ref().columns;
        for height in (to..=from).rev() {
            let n = rows_in(height);
            for i in 0..n {
                // tx_index 0 is the coinbase, which is never written.
                sink.push(i as i32 + 1, &row(height, i, columns), columns)
                    .unwrap();
            }
            sink.end_block(&BlockOutcome {
                height,
                hash: format!("hash{height}"),
                tx_count: n as u64 + 1,
                rows: n as u64,
                ..Default::default()
            })
            .unwrap();
        }
    }

    fn count(path: &Path, sql: &str) -> i64 {
        Connection::open(path)
            .unwrap()
            .query_row(sql, [], |r| r.get(0))
            .unwrap()
    }

    fn write_rows(path: &Path, n: usize, batch_size: usize) -> DataFrame {
        let columns = &schema_ref().columns;
        // Exercise it through the trait object, the way `scan` drives it.
        let mut sink: Box<dyn RowSink> =
            Box::new(ParquetSink::new(path, columns, batch_size).unwrap());
        for i in 0..n {
            sink.push(i as i32 + 1, &row(i as i32, i, columns), columns)
                .unwrap();
        }
        assert_eq!(sink.finish().unwrap(), n as u64);

        ParquetReader::new(File::open(path).unwrap())
            .finish()
            .unwrap()
    }

    /// Row-group size must not change the data that comes back out.
    #[test]
    fn batching_does_not_change_contents() {
        let dir = std::env::temp_dir().join("kp_parquet_stream_test");
        std::fs::create_dir_all(&dir).unwrap();

        let streamed = write_rows(&dir.join("many.parquet"), 250, 7);
        let single = write_rows(&dir.join("one.parquet"), 250, 10_000);

        assert_eq!(streamed.shape(), single.shape());
        assert_eq!(streamed.shape().0, 250);
        assert!(streamed.equals(&single), "row groups changed the contents");

        // Metadata columns survived the round trip in order.
        let heights = streamed.column("block_height").unwrap().i32().unwrap();
        assert_eq!(heights.get(0), Some(0));
        assert_eq!(heights.get(249), Some(249));
        let tx_index = streamed.column("tx_index").unwrap().i32().unwrap();
        assert_eq!(tx_index.get(249), Some(250));
    }

    /// A partial trailing batch must still be flushed by `finish`.
    #[test]
    fn trailing_partial_batch_is_written() {
        let dir = std::env::temp_dir().join("kp_parquet_stream_test");
        std::fs::create_dir_all(&dir).unwrap();
        // 10 rows at batch 4 => 2 full groups + a 2-row tail.
        let df = write_rows(&dir.join("tail.parquet"), 10, 4);
        assert_eq!(df.shape().0, 10);
    }

    /// Zero rows must still produce a readable file carrying the schema.
    #[test]
    fn empty_input_writes_valid_file() {
        let dir = std::env::temp_dir().join("kp_parquet_stream_test");
        std::fs::create_dir_all(&dir).unwrap();
        let df = write_rows(&dir.join("empty.parquet"), 0, 16);
        assert_eq!(df.shape().0, 0);
        assert_eq!(df.width(), schema_ref().columns.len() + 2);
    }

    /// A scan killed after a few commits and resumed must equal one that ran straight through.
    #[test]
    fn resume_matches_uninterrupted_run() {
        let columns = &schema_ref().columns;
        let whole = db_path("whole");
        let mut sink = DuckDbSink::create(&whole, &range(0, 20), columns).unwrap();
        feed(&mut sink, 20, 0);
        Box::new(sink).finish().unwrap();

        let split = db_path("split");
        let mut sink = DuckDbSink::create(&split, &range(0, 20), columns).unwrap();
        sink.commit_rows = 4;
        feed(&mut sink, 20, 9);
        drop(sink); // killed: the uncommitted tail is lost

        let (mut sink, state) = DuckDbSink::open(&split, columns).unwrap();
        let (lowest, hash) = state.lowest_done.expect("some blocks committed");
        assert!(
            lowest > 9,
            "the tail after the last commit must not be done"
        );
        assert_eq!(hash, format!("hash{lowest}"));
        feed(&mut sink, lowest - 1, 0);
        Box::new(sink).finish().unwrap();

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "ATTACH '{}' AS a (READ_ONLY); ATTACH '{}' AS b (READ_ONLY);",
            whole.display(),
            split.display()
        ))
        .unwrap();
        for table in ["txs", "blocks"] {
            let diff: i64 = conn
                .query_row(
                    &format!(
                        "SELECT (SELECT count(*) FROM (FROM a.{table} EXCEPT ALL FROM b.{table}))
                              + (SELECT count(*) FROM (FROM b.{table} EXCEPT ALL FROM a.{table}))"
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(diff, 0, "{table} differs after resume");
        }
        let rows: i64 = (0..=20).map(|h| rows_in(h) as i64).sum();
        assert_eq!(count(&split, "SELECT count(*) FROM txs"), rows);
    }

    /// Rows and blocks pushed after the last commit leave no trace when the run dies.
    #[test]
    fn uncommitted_batch_leaves_nothing() {
        let columns = &schema_ref().columns;
        let path = db_path("uncommitted");
        let mut sink = DuckDbSink::create(&path, &range(0, 10), columns).unwrap();
        feed(&mut sink, 10, 0);
        drop(sink);

        assert_eq!(count(&path, "SELECT count(*) FROM txs"), 0);
        assert_eq!(count(&path, "SELECT count(*) FROM blocks"), 0);
        // With nothing committed, resume restarts at the end height.
        let (_, state) = DuckDbSink::open(&path, columns).unwrap();
        assert!(state.lowest_done.is_none());
        assert_eq!(state.range.end_height, 10);
    }

    /// Blocks that write no rows still count as done.
    #[test]
    fn zero_row_blocks_are_done() {
        let columns = &schema_ref().columns;
        let path = db_path("zero_rows");
        let mut sink = DuckDbSink::create(&path, &range(0, 5), columns).unwrap();
        for height in (0..=5).rev() {
            sink.end_block(&BlockOutcome {
                height,
                hash: format!("hash{height}"),
                tx_count: 1,
                ..Default::default()
            })
            .unwrap();
        }
        assert_eq!(Box::new(sink).finish().unwrap(), 0);
        assert_eq!(count(&path, "SELECT count(*) FROM blocks"), 6);
        assert_eq!(count(&path, "SELECT count(*) FROM txs"), 0);
    }

    #[test]
    fn start_refuses_existing_file() {
        let columns = &schema_ref().columns;
        let path = db_path("exists");
        Box::new(DuckDbSink::create(&path, &range(0, 1), columns).unwrap())
            .finish()
            .unwrap();
        let err = DuckDbSink::create(&path, &range(0, 1), columns)
            .err()
            .unwrap();
        assert!(err.contains("already exists"), "{err}");
    }

    fn open_err(path: &Path) -> String {
        DuckDbSink::open(path, &schema_ref().columns).err().unwrap()
    }

    #[test]
    fn resume_refuses_missing_file() {
        assert!(open_err(&db_path("missing")).contains("does not exist"));
    }

    #[test]
    fn resume_refuses_complete_scan() {
        let columns = &schema_ref().columns;
        let path = db_path("complete");
        let mut sink = DuckDbSink::create(&path, &range(0, 5), columns).unwrap();
        feed(&mut sink, 5, 0);
        Box::new(sink).finish().unwrap();
        assert!(open_err(&path).contains("already complete"));
    }

    #[test]
    fn resume_refuses_schema_drift() {
        let columns = &schema_ref().columns;
        let path = db_path("drift");
        drop(DuckDbSink::create(&path, &range(0, 5), columns).unwrap());
        Connection::open(&path)
            .unwrap()
            .execute_batch("ALTER TABLE txs DROP COLUMN fp_version")
            .unwrap();
        assert!(open_err(&path).contains("different feature schema"));
    }

    #[test]
    fn resume_refuses_gap_in_done_blocks() {
        let columns = &schema_ref().columns;
        let path = db_path("gap");
        let mut sink = DuckDbSink::create(&path, &range(0, 10), columns).unwrap();
        feed(&mut sink, 10, 5);
        Box::new(sink).finish().unwrap();
        Connection::open(&path)
            .unwrap()
            .execute_batch("DELETE FROM blocks WHERE height = 7")
            .unwrap();
        assert!(open_err(&path).contains("not one contiguous run"));
    }
}
