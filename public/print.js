/* Fixed-slot fingerprint code, one token per habit, always in this order:
   version, sequence, locktime, script, sighash, rune.
   Signature length is not a habit: low-r and high-r are omitted. */

const FACETS = [
  ["version", "Version"],
  ["seq", "Sequence"],
  ["lock", "Locktime"],
  ["family", "Script"],
  ["sighash", "Signature"],
  ["rune", "Runestone"],
];

const LABEL = {
  v1: "v1", v2: "v2", v3: "v3", v_other: "not 1–3",
  final: "final", rbf: "RBF", locktime_no_rbf: "no RBF",
  rel_blocks: "relative", rel_time: "relative time",
  seq_mixed: "mixed", seq_other: "other",
  lt0: "0", lt_tip: "1 block", lt_2_9: "2–9",
  lt_10_99: "10–99", "lt_100+": "100+", lt_time: "time",
  lt_exact: "same block", lt_future: "future",
  p2wpkh: "wpkh", p2pkh: "pkh", p2sh_p2wpkh: "sh-wpkh",
  p2tr_key: "tr key", p2tr_script: "tr script", inscription: "insc",
  p2wsh: "wsh", p2sh_p2wsh: "sh-wsh", p2sh: "sh", mixed_inputs: "mixed",
  p2a: "anchor", p2pk: "pk",
  ecdsa_ALL: "ALL", "ecdsa_ALL|ACP": "ALL|ACP", "ecdsa_SINGLE|ACP": "SINGLE|ACP",
  schnorr_default: "schnorr", schnorr_explicit_all: "schnorr ALL",
  "schnorr_explicit_ALL|ACP": "schnorr ALL|ACP",
  "schnorr_explicit_SINGLE|ACP": "schnorr SINGLE|ACP",
  nosig: "no sig",
  rune: "rune", plain: "plain",
};

const TIP = {
  v1: "nVersion 1.",
  v2: "nVersion 2.",
  v3: "nVersion 3. TRUC.",
  v_other: "nVersion is not 1, 2, or 3.",
  rel_blocks: "Relative lock, counted in blocks.",
  rel_time: "Relative lock, counted in time.",
  final: "Final nSequence.",
  rbf: "RBF signaled.",
  locktime_no_rbf: "Locktime is enabled and RBF is not signaled.",
  seq_mixed: "Inputs disagree on nSequence.",
  seq_other: "nSequence is not final, RBF, locktime-only, or a relative lock.",
};

const TOKEN = {
  v1: "1", v2: "2", v3: "3", v_other: "X",
  final: "F", rbf: "R", locktime_no_rbf: "K",
  rel_blocks: "B", rel_time: "T", seq_mixed: "M", seq_other: "S",
  lt0: "0", lt_tip: "1", lt_2_9: "9", lt_10_99: "d", "lt_100+": "+",
  lt_time: "t", lt_exact: "e", lt_future: "f",
  p2wpkh: "W", p2pkh: "K", p2sh_p2wpkh: "N",
  p2tr_key: "T", p2tr_script: "C", inscription: "I",
  p2wsh: "H", p2sh_p2wsh: "Q", p2sh: "P", mixed_inputs: "M", p2a: "A", p2pk: "k",
  rune: "R", plain: "p",
  other: "?",
};

const SIG_ATOM = {
  ecdsa_ALL: "A",
  "ecdsa_ALL|ACP": "a",
  "ecdsa_SINGLE|ACP": "S",
  schnorr_default: "D",
  schnorr_explicit_all: "E",
  "schnorr_explicit_ALL|ACP": "e",
  "schnorr_explicit_SINGLE|ACP": "s",
  nosig: "0",
  other: "?",
};
const SIG_RANK = Object.keys(SIG_ATOM);

function facetLabel(key, value) {
  if (value == null || value === "") return "";
  if (value === "other") return key === "family" ? "other script" : "other";
  if (key === "sighash" && String(value).includes("+")) {
    return String(value).split("+").map((part) => LABEL[part] || part).join("+");
  }
  return LABEL[value] || String(value);
}

function tipFor(key, value) {
  if (value === "v_other") return TIP.v_other;
  if (value === "other" && key === "family") return "Spent script was not one of the named types.";
  if (TIP[value]) return TIP[value];
  return facetLabel(key, value);
}

function sighashToken(value) {
  if (value == null || value === "") return "";
  const parts = String(value).split("+");
  const known = [];
  const unknown = [];
  for (const part of parts) {
    if (SIG_ATOM[part]) known.push(part);
    else unknown.push(part);
  }
  known.sort((a, b) => SIG_RANK.indexOf(a) - SIG_RANK.indexOf(b));
  let token = known.map((part) => SIG_ATOM[part]).join("");
  if (unknown.length) token += `?${unknown.join("+")}`;
  return token || "?";
}

function facetToken(key, value) {
  if (key === "sighash") return sighashToken(value);
  if (value == null || value === "") return "";
  return TOKEN[value] || "?";
}

function fingerprintCode(fp) {
  if (!fp) return "";
  return FACETS.map(([key]) => facetToken(key, fp[key])).join("·");
}

function fingerprintWords(fp) {
  if (!fp) return [];
  return FACETS.map(([key]) => facetLabel(key, fp[key])).filter(Boolean);
}

function oneInCount(p) {
  if (!(p > 0)) return null;
  if (p >= 1) return 1;
  return Math.max(2, Math.round(1 / p));
}

function windowLine(data) {
  const span = data.window.end_height - data.window.start_height + 1;
  return `Collected over ${span.toLocaleString()} blocks`;
}

function withoutLowr(state) {
  if (!state || state === "other") return "other";
  const parts = String(state).split("|");
  if (parts.length < 5) return state;
  const tail = parts[parts.length - 1];
  let rune = "";
  if (tail === "rune" || tail === "plain") rune = parts.pop();
  const mark = parts[parts.length - 1];
  if (mark === "grind" || mark === "nogrind" || mark === "na" || mark === "other") parts.pop();
  if (rune) parts.push(rune);
  return parts.join("|");
}

function collapsePrints(rows) {
  const by = new Map();
  for (const fp of rows) {
    const state = withoutLowr(fp.state);
    const prev = by.get(state);
    if (!prev) {
      const copy = { ...fp, state };
      delete copy.lowr;
      by.set(state, copy);
    } else prev.n += fp.n;
  }
  return [...by.values()].sort((a, b) => b.n - a.n).map((fp, id) => ({ ...fp, id }));
}
