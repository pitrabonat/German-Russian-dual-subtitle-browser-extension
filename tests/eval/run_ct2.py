"""Translates the test set with a CTranslate2 OPUS-MT model and records per-sentence latency.

Usage:
    python tests/eval/run_ct2.py --model-dir models/ct2/opus-mt-tc-big-de-zle-int8 --beam 2 --out tests/results/translation/ct2-int8-beam2.json

Three ways of handling sentence fragments are recorded for items that carry a `group`:
    isolated  each subtitle line is translated on its own
    merged    the lines of a group are joined and translated as one sentence
    prefix    the joined sentence is decoded with the translation of the earlier lines forced as
              a target prefix; only the continuation is kept for the current line
"""
import argparse
import json
import os
import statistics
import sys
import time

import ctranslate2
import sentencepiece as spm

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def load_translator(model_dir, compute_type, threads):
    """Loads from the path first; falls back to in-memory files when the path is not usable
    (CTranslate2 opens files with narrow strings, which breaks on some non-ASCII Windows paths)."""
    try:
        return ctranslate2.Translator(model_dir, device="cpu", compute_type=compute_type, intra_threads=threads), "path"
    except Exception as first_error:  # noqa: BLE001
        files = {name: read_bytes(os.path.join(model_dir, name)) for name in os.listdir(model_dir) if name.endswith((".bin", ".json", ".txt"))}
        try:
            return ctranslate2.Translator("model", device="cpu", compute_type=compute_type, intra_threads=threads, files=files), "memory"
        except Exception:
            raise first_error


def load_spm(path):
    try:
        return spm.SentencePieceProcessor(model_file=path), "path"
    except Exception:  # noqa: BLE001
        return spm.SentencePieceProcessor(model_proto=read_bytes(path)), "memory"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--beam", type=int, default=2)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--out", required=True)
    ap.add_argument("--label", default=None)
    args = ap.parse_args()

    model_dir = os.path.join(ROOT, args.model_dir) if not os.path.isabs(args.model_dir) else args.model_dir
    with open(os.path.join(ROOT, "tests", "data", "translation-set.json"), encoding="utf-8") as f:
        items = json.load(f)["items"]

    t0 = time.perf_counter()
    translator, how_model = load_translator(model_dir, args.compute_type, args.threads)
    src_sp, how_spm = load_spm(os.path.join(model_dir, "source.spm"))
    tgt_sp, _ = load_spm(os.path.join(model_dir, "target.spm"))

    def encode(text):
        return [">>rus<<"] + src_sp.encode(text, out_type=str) + ["</s>"]

    def translate(text, prefix=None):
        kwargs = dict(beam_size=args.beam, max_decoding_length=256, repetition_penalty=1.0)
        if prefix is not None:
            kwargs["target_prefix"] = [prefix]
        result = translator.translate_batch([encode(text)], **kwargs)
        return result[0].hypotheses[0]

    translate("Guten Tag.")  # warm-up; the first call pays for lazy allocations
    init_ms = (time.perf_counter() - t0) * 1000

    out_items = []
    latencies = []
    for it in items:
        t = time.perf_counter()
        hyp = tgt_sp.decode(translate(it["de"]))
        ms = (time.perf_counter() - t) * 1000
        latencies.append(ms)
        out_items.append({"id": it["id"], "hyp": hyp, "ms": round(ms, 1)})

    # Fragment strategies.
    groups = {}
    for it in items:
        if "group" in it:
            groups.setdefault(it["group"], []).append(it)
    fragments = []
    for gid, parts in groups.items():
        merged_src = " ".join(p["de"] for p in parts)
        t = time.perf_counter()
        merged = tgt_sp.decode(translate(merged_src))
        merged_ms = (time.perf_counter() - t) * 1000
        isolated = [tgt_sp.decode(translate(p["de"])) for p in parts]
        # prefix-constrained continuation: decode the growing source with the already shown target forced
        shown_tokens = []
        prefix_parts = []
        for k, p in enumerate(parts):
            src = " ".join(q["de"] for q in parts[: k + 1])
            hyp_tokens = translate(src, prefix=shown_tokens if shown_tokens else None)
            new_tokens = hyp_tokens[len(shown_tokens):]
            prefix_parts.append(tgt_sp.decode(new_tokens))
            shown_tokens = hyp_tokens
        fragments.append({
            "group": gid,
            "de": [p["de"] for p in parts],
            "isolated": isolated,
            "merged": merged,
            "prefix": prefix_parts,
            "mergedMs": round(merged_ms, 1),
        })

    lat_sorted = sorted(latencies)
    summary = {
        "provider": args.label or f"ct2-{args.compute_type}-beam{args.beam}",
        "runtime": f"CTranslate2 {ctranslate2.__version__}, {args.threads} threads, {args.compute_type}",
        "modelDir": args.model_dir,
        "loadedFrom": {"model": how_model, "spm": how_spm},
        "initMs": round(init_ms),
        "latency": {
            "avg": round(statistics.mean(latencies), 1),
            "median": round(statistics.median(latencies), 1),
            "p95": round(lat_sorted[int(len(lat_sorted) * 0.95) - 1], 1),
            "max": round(lat_sorted[-1], 1),
        },
    }
    out_path = os.path.join(ROOT, args.out) if not os.path.isabs(args.out) else args.out
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({**summary, "items": out_items, "fragments": fragments}, f, ensure_ascii=False, indent=1)
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
