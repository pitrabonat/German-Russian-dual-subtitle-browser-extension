"""Converts Helsinki-NLP/opus-mt-tc-big-de-zle into the layout transformers.js expects.

    python tools/model/export_onnx.py --src <dir with the Hugging Face files> --work <scratch dir> --out models/browser/opus-mt-tc-big-de-zle

Steps
  1. ONNX export with optimum (encoder_model.onnx, decoder_model_merged.onnx, float32).
  2. Dynamic int8 quantization of the weights (onnxruntime), which is what the browser runs.
  3. tokenizer.json for the JavaScript Unigram tokenizer, built from vocab.json and the
     SentencePiece model. Marian has no "fast" tokenizer, so this file does not exist upstream.

Both --src and --work must be ASCII-only paths: SentencePiece and the ONNX exporter open files
with narrow strings on Windows. --out may be any path.
"""
import argparse
import base64
import json
import os
import shutil
import sys
import time


def patch_optimum_for_py314():
    """Python 3.14 made functools.partial a method descriptor. optimum 2.1 stores partials as class
    attributes (NORMALIZED_CONFIG_CLASS) and calls them through `self`, which now injects `self`
    as the first argument. Wrapping them in staticmethod restores the old behaviour."""
    import functools
    import importlib
    import inspect

    if sys.version_info < (3, 14):
        return
    for name in ("optimum.exporters.onnx.model_configs", "optimum.exporters.onnx.config", "optimum.exporters.onnx.base", "optimum.exporters.base"):
        try:
            module = importlib.import_module(name)
        except ImportError:
            continue
        for _, cls in inspect.getmembers(module, inspect.isclass):
            for attr, value in list(vars(cls).items()):
                if isinstance(value, functools.partial):
                    setattr(cls, attr, staticmethod(value))


def export_fp32(src, fp32_dir):
    from optimum.exporters.onnx import main_export

    patch_optimum_for_py314()

    if os.path.exists(os.path.join(fp32_dir, "decoder_model_merged.onnx")):
        print("fp32 export already present, skipping")
        return
    t = time.time()
    main_export(src, output=fp32_dir, task="text2text-generation-with-past", device="cpu", do_validation=False)
    print(f"exported in {time.time() - t:.0f} s")


def quantize(fp32_dir, onnx_out):
    import onnx
    from onnxruntime.quantization import QuantType, quantize_dynamic

    os.makedirs(onnx_out, exist_ok=True)
    for name in ("encoder_model", "decoder_model_merged"):
        src = os.path.join(fp32_dir, f"{name}.onnx")
        dst = os.path.join(onnx_out, f"{name}_quantized.onnx")
        if os.path.exists(dst):
            print(f"{dst} already present, skipping")
            continue
        t = time.time()
        ops = {node.op_type for node in onnx.load(src, load_external_data=False).graph.node}
        quantize_dynamic(
            model_input=src,
            model_output=dst,
            # Signed weights are the better fit for MatMul-only models; Conv models need unsigned.
            weight_type=QuantType.QUInt8 if "Conv" in ops else QuantType.QInt8,
            per_channel=False,
            reduce_range=False,
            # The merged decoder keeps its two branches inside If nodes.
            extra_options={"EnableSubgraph": True, "MatMulConstBOnly": True},
        )
        print(f"{name}: {os.path.getsize(src) / 1e6:.0f} MB -> {os.path.getsize(dst) / 1e6:.0f} MB in {time.time() - t:.0f} s")


def build_tokenizer_json(src):
    """Unigram tokenizer over the shared Marian vocabulary, with scores from the SentencePiece models."""
    from sentencepiece import sentencepiece_model_pb2 as sp_pb2

    with open(os.path.join(src, "vocab.json"), encoding="utf-8") as f:
        vocab = json.load(f)
    by_id = sorted(vocab.items(), key=lambda kv: kv[1])
    assert [i for _, i in by_id] == list(range(len(by_id))), "vocab ids are not contiguous"

    scores = {}
    charsmap = b""
    for name in ("target.spm", "source.spm"):  # source last: its scores win for shared pieces
        proto = sp_pb2.ModelProto()
        with open(os.path.join(src, name), "rb") as f:
            proto.ParseFromString(f.read())
        for piece in proto.pieces:
            scores[piece.piece] = piece.score
        charsmap = proto.normalizer_spec.precompiled_charsmap
    floor = min(scores.values()) - 10.0

    special = ["</s>", "<unk>", "<pad>"]
    eos_id, unk_id = vocab["</s>"], vocab["<unk>"]
    return {
        "version": "1.0",
        "truncation": None,
        "padding": None,
        "added_tokens": [
            {"id": vocab[t], "content": t, "single_word": False, "lstrip": False, "rstrip": False, "normalized": False, "special": True}
            for t in special
        ],
        "normalizer": {"type": "Precompiled", "precompiled_charsmap": base64.b64encode(charsmap).decode("ascii")},
        "pre_tokenizer": {
            "type": "Sequence",
            "pretokenizers": [
                {"type": "WhitespaceSplit"},
                {"type": "Metaspace", "replacement": "▁", "add_prefix_space": True, "prepend_scheme": "always"},
            ],
        },
        "post_processor": {
            "type": "TemplateProcessing",
            "single": [{"Sequence": {"id": "A", "type_id": 0}}, {"SpecialToken": {"id": "</s>", "type_id": 0}}],
            "pair": [
                {"Sequence": {"id": "A", "type_id": 0}},
                {"SpecialToken": {"id": "</s>", "type_id": 0}},
                {"Sequence": {"id": "B", "type_id": 0}},
                {"SpecialToken": {"id": "</s>", "type_id": 0}},
            ],
            "special_tokens": {"</s>": {"id": "</s>", "ids": [eos_id], "tokens": ["</s>"]}},
        },
        "decoder": {"type": "Metaspace", "replacement": "▁", "add_prefix_space": True, "prepend_scheme": "always"},
        "model": {
            "type": "Unigram",
            "unk_id": unk_id,
            # Language tags (>>rus<<) and special tokens are never produced by segmentation; score 0 is fine.
            "vocab": [[piece, 0.0 if piece in special or piece.startswith(">>") else scores.get(piece, floor)] for piece, _ in by_id],
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    fp32_dir = os.path.join(args.work, "onnx-fp32")
    staged = os.path.join(args.work, "browser-model")
    export_fp32(args.src, fp32_dir)
    quantize(fp32_dir, os.path.join(staged, "onnx"))

    with open(os.path.join(args.src, "config.json"), encoding="utf-8") as f:
        config = json.load(f)
    # transformers.js decodes greedily; a beam setting in the configs would only cause warnings.
    config["num_beams"] = 1
    with open(os.path.join(staged, "config.json"), "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    with open(os.path.join(args.src, "generation_config.json"), encoding="utf-8") as f:
        generation = json.load(f)
    generation["num_beams"] = 1
    with open(os.path.join(staged, "generation_config.json"), "w", encoding="utf-8") as f:
        json.dump(generation, f, indent=2)
    with open(os.path.join(staged, "tokenizer_config.json"), "w", encoding="utf-8") as f:
        json.dump({
            "tokenizer_class": "MarianTokenizer",
            "model_max_length": 512,
            "eos_token": "</s>",
            "unk_token": "<unk>",
            "pad_token": "<pad>",
            "source_lang": "de",
            "target_lang": "zle",
            "separate_vocabs": False,
            "clean_up_tokenization_spaces": False,
        }, f, indent=2)
    with open(os.path.join(staged, "tokenizer.json"), "w", encoding="utf-8") as f:
        json.dump(build_tokenizer_json(args.src), f, ensure_ascii=False)

    if os.path.exists(args.out):
        shutil.rmtree(args.out)
    shutil.copytree(staged, args.out)
    total = sum(os.path.getsize(os.path.join(root, name)) for root, _, names in os.walk(args.out) for name in names)
    print(f"browser model written to {args.out}: {total / 1e6:.0f} MB")


if __name__ == "__main__":
    sys.exit(main())
