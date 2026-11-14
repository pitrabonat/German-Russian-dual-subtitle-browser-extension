"""Mitlesen local service.

Optional companion of the browser extension. It gives the extension two things a browser
cannot run well:

  POST /translate   German -> Russian with OPUS-MT (opus-mt-tc-big-de-zle) through CTranslate2
  POST /analyze     dependency parse of a German sentence with spaCy
  GET  /health      what is loaded

It listens on 127.0.0.1 only and answers nobody but browser extensions and local tools:
a request that carries the Origin of a web page is refused, and so is a request whose Host
header is not a loopback name (protection against DNS rebinding).

Usage:
    python mitlesen_service.py --download      fetch the translation model (242 MB, verified by SHA-256)
    python mitlesen_service.py                 start on http://127.0.0.1:8765
"""
import argparse
import hashlib
import json
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.1.0"
DEFAULT_PORT = 8765
HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_NAME = "opus-mt-tc-big-de-zle-ct2-int8"
MODEL_REPO = "https://huggingface.co/NothingSoftware/opus-mt-tc-big-de-zle-ct2-int8/resolve/main/"
# SHA-256 of the files as published in the model card. The model itself is a CTranslate2
# conversion of Helsinki-NLP/opus-mt-tc-big-de-zle (CC BY 4.0).
MODEL_FILES = {
    "config.json": "72901fbd8abd89fb5cf4a388f26fc681f5c4c58a1e1a88b30b879f107270e7ee",
    "model.bin": "2534ced3ddba7feeb35745f4039a4133ac660ffcfd615e45a442471097803cf0",
    "shared_vocabulary.json": "5b8652a61db35b73b254f0390930e7174ed1bfa047acc5b2df082ff97c03c911",
    "source.spm": "dde526685600b958138d2b3863bf9b8be10774bf8a99573aede7db619c9b5eb0",
    "target.spm": "3341e4c42304e509ef8068c1b0726be116a8ad90b513c62638db210bf47b4fb6",
}
MAX_BODY = 256 * 1024
MAX_TEXTS = 32
MAX_TEXT_CHARS = 2000


def default_model_dir():
    """The model next to the service, or the copy the project keeps for benchmarks."""
    candidates = [
        os.path.join(HERE, "models", MODEL_NAME),
        os.path.join(HERE, "..", "models", "ct2", "opus-mt-tc-big-de-zle-int8"),
    ]
    for path in candidates:
        if os.path.exists(os.path.join(path, "model.bin")):
            return os.path.abspath(path)
    return os.path.abspath(candidates[0])


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def download_model(model_dir):
    os.makedirs(model_dir, exist_ok=True)
    for name, expected in MODEL_FILES.items():
        target = os.path.join(model_dir, name)
        if os.path.exists(target) and sha256(target) == expected:
            print(f"{name}: already present")
            continue
        print(f"{name}: downloading ...", flush=True)
        partial = target + ".part"
        urllib.request.urlretrieve(MODEL_REPO + name, partial)
        actual = sha256(partial)
        if actual != expected:
            os.remove(partial)
            raise SystemExit(f"{name}: checksum mismatch (got {actual}); the file was not kept")
        os.replace(partial, target)
    print(f"model ready in {model_dir}")


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def cuda_library_dirs(extra):
    """Folders that may hold cublas64_12.dll: one given on the command line, and the
    nvidia-cublas-cu12 pip package if it is installed in this environment."""
    found = []
    if extra and os.path.isdir(extra):
        found.append(os.path.abspath(extra))
    for base in sys.path:
        candidate = os.path.join(base, "nvidia", "cublas", "bin")
        if os.path.isdir(candidate):
            found.append(candidate)
    return found


class Translator:
    """OPUS-MT German -> Russian. Loaded in the background; `error` explains a failed load."""

    def __init__(self, model_dir, device, threads, cuda_lib_dir=None):
        self.model_dir = model_dir
        self.device_wanted = device
        self.threads = threads
        self.cuda_lib_dir = cuda_lib_dir
        self.ready = False
        self.error = None
        self.device = None
        self.fallback_reason = None
        self._lock = threading.Lock()

    def load(self):
        try:
            import ctranslate2
            import sentencepiece as spm

            if not os.path.exists(os.path.join(self.model_dir, "model.bin")):
                raise FileNotFoundError("translation model not found; run: python mitlesen_service.py --download")
            # SentencePiece opens files with narrow strings, which fails on non-ASCII Windows paths.
            self._src = spm.SentencePieceProcessor(model_proto=read_bytes(os.path.join(self.model_dir, "source.spm")))
            self._tgt = spm.SentencePieceProcessor(model_proto=read_bytes(os.path.join(self.model_dir, "target.spm")))
            for directory in cuda_library_dirs(self.cuda_lib_dir):
                os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")
                if hasattr(os, "add_dll_directory"):
                    os.add_dll_directory(directory)
            devices = []
            if self.device_wanted in ("auto", "cuda") and ctranslate2.get_cuda_device_count() > 0:
                devices.append(("cuda", "int8_float16"))
            if self.device_wanted != "cuda":
                devices.append(("cpu", "int8"))
            last = None
            for device, compute in devices:
                try:
                    self._translator = self._open(ctranslate2, device, compute)
                    # The CUDA libraries are loaded on first use, so the trial run belongs here:
                    # if cuBLAS is missing, the CPU takes over instead of the service failing.
                    self.translate(["Guten Tag."])
                    self.device = f"{device} ({compute})" if device == "cuda" else f"cpu ({compute}, {self.threads} threads)"
                    break
                except Exception as e:  # noqa: BLE001
                    last = e
                    self.fallback_reason = f"{device}: {type(e).__name__}: {e}"
            else:
                raise last or RuntimeError("no usable device")
            self.ready = True
        except Exception as e:  # noqa: BLE001
            self.error = f"{type(e).__name__}: {e}"

    def _open(self, ctranslate2, device, compute):
        kwargs = dict(device=device, compute_type=compute, intra_threads=self.threads)
        try:
            return ctranslate2.Translator(self.model_dir, **kwargs)
        except RuntimeError:
            # Same path problem as above: hand the files over from memory instead.
            names = [n for n in os.listdir(self.model_dir) if n.endswith((".bin", ".json"))]
            files = {n: read_bytes(os.path.join(self.model_dir, n)) for n in names}
            return ctranslate2.Translator("model", files=files, **kwargs)

    def translate(self, texts):
        # The model serves three East Slavic languages; the tag selects Russian.
        batch = [[">>rus<<"] + self._src.encode(t, out_type=str) + ["</s>"] for t in texts]
        with self._lock:
            results = self._translator.translate_batch(batch, beam_size=2, max_decoding_length=256, max_batch_size=8)
        return [self._tgt.decode(r.hypotheses[0]) for r in results]


class Analyzer:
    """spaCy pipeline for German: lemma, part of speech, morphology and dependencies."""

    def __init__(self, model):
        self.model_wanted = model
        self.model = None
        self.ready = False
        self.error = None
        self._lock = threading.Lock()

    def load(self):
        try:
            import spacy

            names = [self.model_wanted] if self.model_wanted else ["de_core_news_md", "de_core_news_sm"]
            last = None
            for name in names:
                try:
                    # Named entities are not needed and cost time.
                    self._nlp = spacy.load(name, exclude=["ner"])
                    self.model = f"{name} {self._nlp.meta.get('version', '')}".strip()
                    break
                except OSError as e:
                    last = e
            else:
                raise last or OSError("no spaCy model")
            self.analyze("Ich stehe auf.")
            self.ready = True
        except Exception as e:  # noqa: BLE001
            self.error = f"{type(e).__name__}: {e}"

    def analyze(self, text):
        with self._lock:
            doc = self._nlp(text)
        return [
            {
                "start": t.idx,
                "end": t.idx + len(t.text),
                "text": t.text,
                "lemma": t.lemma_,
                "pos": t.pos_,
                "tag": t.tag_,
                "morph": t.morph.to_dict(),
                "dep": t.dep_,
                "head": t.head.i,
            }
            for t in doc
        ]


class Handler(BaseHTTPRequestHandler):
    server_version = f"Mitlesen/{VERSION}"
    protocol_version = "HTTP/1.1"
    translator: Translator
    analyzer: Analyzer
    allowed_origin = None

    def log_message(self, fmt, *args):  # no request logging: subtitle text stays out of log files
        return

    # ── access control ──

    def _origin_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0].strip("[]")
        if host not in ("127.0.0.1", "localhost", "::1"):
            return False
        origin = self.headers.get("Origin")
        if not origin:
            return True  # local tools: curl, the benchmark scripts
        if self.allowed_origin:
            return origin == self.allowed_origin
        return origin.startswith(("chrome-extension://", "moz-extension://"))

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin")
        if origin and self._origin_ok():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def _json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            raise ValueError("request body missing or too large")
        data = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSON object expected")
        return data

    # ── routes ──

    def do_OPTIONS(self):
        if not self._origin_ok():
            return self._send(403, {"error": "origin not allowed"})
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self._origin_ok():
            return self._send(403, {"error": "origin not allowed"})
        if self.path != "/health":
            return self._send(404, {"error": "not found"})
        t, a = self.translator, self.analyzer
        self._send(200, {
            "service": "mitlesen",
            "version": VERSION,
            "translate": {"ready": t.ready, "model": "opus-mt-tc-big-de-zle (CTranslate2 int8)", "device": t.device, "error": t.error, "note": t.fallback_reason},
            "analyze": {"ready": a.ready, "model": a.model, "error": a.error},
        })

    def do_POST(self):
        if not self._origin_ok():
            return self._send(403, {"error": "origin not allowed"})
        try:
            data = self._json_body()
        except (ValueError, json.JSONDecodeError) as e:
            return self._send(400, {"error": str(e)})
        started = time.perf_counter()
        try:
            if self.path == "/translate":
                texts = data.get("texts")
                if not isinstance(texts, list) or not 0 < len(texts) <= MAX_TEXTS or not all(isinstance(t, str) and 0 < len(t) <= MAX_TEXT_CHARS for t in texts):
                    return self._send(400, {"error": f"'texts' must be a list of 1..{MAX_TEXTS} non-empty strings"})
                if not self.translator.ready:
                    return self._send(503, {"error": self.translator.error or "translation model is still loading"})
                out = self.translator.translate(texts)
                return self._send(200, {"translations": out, "ms": round((time.perf_counter() - started) * 1000)})
            if self.path == "/analyze":
                text = data.get("text")
                if not isinstance(text, str) or not 0 < len(text) <= MAX_TEXT_CHARS:
                    return self._send(400, {"error": "'text' must be a non-empty string"})
                if not self.analyzer.ready:
                    return self._send(503, {"error": self.analyzer.error or "language model is still loading"})
                tokens = self.analyzer.analyze(text)
                return self._send(200, {"tokens": tokens, "model": self.analyzer.model, "ms": round((time.perf_counter() - started) * 1000)})
            return self._send(404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001 - never let one request take the server down
            return self._send(500, {"error": f"{type(e).__name__}: {e}"})


def main():
    ap = argparse.ArgumentParser(description="Mitlesen local service")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--model-dir", default=None, help="directory of the CTranslate2 model")
    ap.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    ap.add_argument("--threads", type=int, default=max(1, min(4, (os.cpu_count() or 2) // 2)))
    ap.add_argument("--spacy-model", default=None, help="spaCy model name (default: de_core_news_md, then de_core_news_sm)")
    ap.add_argument("--cuda-lib-dir", default=os.environ.get("MITLESEN_CUDA_LIB_DIR"), help="folder with cublas64_12.dll, for example Ollama's lib/ollama/cuda_v12")
    ap.add_argument("--allow-origin", default=None, help="accept only this extension origin, e.g. chrome-extension://<id>")
    ap.add_argument("--download", action="store_true", help="download the translation model and exit")
    args = ap.parse_args()

    model_dir = os.path.abspath(args.model_dir) if args.model_dir else default_model_dir()
    if args.download:
        download_model(model_dir)
        return

    Handler.translator = Translator(model_dir, args.device, args.threads, args.cuda_lib_dir)
    Handler.analyzer = Analyzer(args.spacy_model)
    Handler.allowed_origin = args.allow_origin
    # Models load in the background, so /health answers at once and reports progress.
    threading.Thread(target=Handler.translator.load, daemon=True).start()
    threading.Thread(target=Handler.analyzer.load, daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"Mitlesen service {VERSION} on http://127.0.0.1:{args.port} (Ctrl+C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    sys.exit(main())
