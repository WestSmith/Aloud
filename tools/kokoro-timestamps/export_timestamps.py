#!/usr/bin/env python3
"""Re-export the Kokoro-82M ONNX graph with its internal per-token duration
tensor exposed as a second output.

Why: Aloud's neural karaoke currently PREDICTS word timing (phoneme-count
heuristics pinned to silences in the waveform). Kokoro itself computes an
exact duration for every input token as part of synthesis — the tensor is
simply not a graph output in the onnx-community export, so kokoro-js never
sees it. Exposing it gives sample-accurate word timing for free: no extra
inference, no extra download beyond the model users already fetch.

This is pure graph surgery (onnx package): no PyTorch, no re-export from
the original checkpoint, and the waveform output is bit-identical.

Usage:
  pip install onnx onnxruntime huggingface_hub numpy

  # 1. see the candidate duration tensors for a given precision tier
  python export_timestamps.py --file onnx/model_quantized.onnx --list

  # 2. export (auto-picks the best candidate; --tensor overrides)
  python export_timestamps.py --file onnx/model_quantized.onnx \
      --out model_quantized.onnx --verify

  # repeat for each tier Aloud offers: model_q4.onnx (Lite),
  # model_q4f16.onnx (Lite+), model_quantized.onnx (Standard/q8),
  # model.onnx (High/fp32)

Then host the patched files (see README.md) and wire the worker.
"""
import argparse
import sys

import onnx
from onnx import shape_inference


def load_model(args):
    if args.model_path:
        path = args.model_path
    else:
        from huggingface_hub import hf_hub_download
        path = hf_hub_download(repo_id=args.src, filename=args.file)
    print(f"loading {path}")
    return onnx.load(path), path


def find_rounded_duration(model):
    """Walk the graph for the StyleTTS2 duration chain:
    Round -> (Clip) -> Cast -> Gather -> CumSum (alignment expansion).

    Returns the tensor holding the rounded, min-clamped per-token frame
    counts as float (the Clip output when present, else the Round output),
    or None if the chain isn't found. This beats name/score heuristics: the
    quantized exports bury 'dur'-named tensors inside dequant subgraphs
    that are NOT the final durations.
    """
    consumers = {}
    for node in model.graph.node:
        for inp in node.input:
            consumers.setdefault(inp, []).append(node)

    def reaches_cumsum(tensor, hops):
        if hops == 0:
            return False
        for n in consumers.get(tensor, []):
            if n.op_type == "CumSum":
                return True
            if any(reaches_cumsum(o, hops - 1) for o in n.output):
                return True
        return False

    for node in model.graph.node:
        if node.op_type != "Round":
            continue
        out = node.output[0]
        if not reaches_cumsum(out, 5):
            continue
        clips = [n for n in consumers.get(out, []) if n.op_type == "Clip"]
        return clips[0].output[0] if clips else out
    return None


def duration_candidates(model):
    """Find tensors that plausibly carry per-token frame durations.

    In StyleTTS2-family graphs (Kokoro included) the duration head ends in a
    rounding/clamping step whose output feeds the alignment expansion. We
    rank: (1) names containing 'dur', (2) outputs of Round/Ceil/Clip nodes
    that are consumed by CumSum/Range/Expand-style alignment ops.
    """
    graph = model.graph
    consumers = {}
    for node in graph.node:
        for inp in node.input:
            consumers.setdefault(inp, []).append(node.op_type)
    cands = []
    for node in graph.node:
        for out in node.output:
            score = 0
            if "dur" in out.lower() or "dur" in node.name.lower():
                score += 2
            if node.op_type in ("Round", "Ceil", "Clip", "Cast"):
                score += 1
            downstream = consumers.get(out, [])
            if any(op in ("CumSum", "Range", "Expand", "GatherND", "ScatterND") for op in downstream):
                score += 2
            if score >= 2:
                cands.append((score, out, node.op_type, ",".join(downstream) or "-"))
    cands.sort(reverse=True)
    return cands


def expose(model, tensor_name, out_path, out_name="pred_dur"):
    # borrow the tensor's type/shape from shape inference so the new graph
    # output is well-typed (required for the model checker to pass)
    inferred = shape_inference.infer_shapes(model)
    vi = None
    for v in list(inferred.graph.value_info) + list(inferred.graph.output):
        if v.name == tensor_name:
            vi = v
            break
    if vi is None:
        vi = onnx.helper.make_tensor_value_info(tensor_name, onnx.TensorProto.FLOAT, None)
        print(f"warning: no inferred type for {tensor_name}; declaring untyped float")
    if out_name != tensor_name:
        # alias via Cast-to-float32, not Identity: the fp16 tiers carry the
        # durations as float16 internally, and browsers can't reliably read
        # float16 tensors (Float16Array is not everywhere yet). Cast makes
        # every tier present the same float32 'pred_dur'; where the tensor
        # is already float32 the Cast is a no-op passthrough. Values are
        # small integers (frame counts), so fp16->fp32 is exact.
        model.graph.node.add().CopyFrom(onnx.helper.make_node(
            "Cast", [tensor_name], [out_name], name=f"expose_{out_name}",
            to=onnx.TensorProto.FLOAT))
    out = model.graph.output.add()
    out.CopyFrom(vi)
    out.name = out_name
    if out_name != tensor_name:
        out.type.tensor_type.elem_type = onnx.TensorProto.FLOAT
    onnx.checker.check_model(model, full_check=False)
    onnx.save(model, out_path)
    print(f"saved {out_path} with extra output '{out_name}' (= {tensor_name})")


def verify(orig_path, patched_path, tensor_name):
    import numpy as np
    import onnxruntime as ort

    def run(path):
        sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        rng = np.random.default_rng(0)
        feeds = {}
        for inp in sess.get_inputs():
            if inp.name == "input_ids":
                # $ ... $ style-boundary padding like the tokenizer produces
                feeds[inp.name] = np.array([[0, 50, 83, 54, 156, 57, 135, 16, 102, 0]], dtype=np.int64)
            elif inp.name == "style":
                feeds[inp.name] = rng.standard_normal((1, 256), dtype=np.float32)
            elif inp.name == "speed":
                feeds[inp.name] = np.ones(1, dtype=np.float32)
            else:
                raise SystemExit(f"unexpected model input {inp.name} — update verify()")
        names = [o.name for o in sess.get_outputs()]
        return names, sess.run(None, feeds)

    n0, r0 = run(orig_path)
    n1, r1 = run(patched_path)
    wave0 = r0[n0.index("waveform")]
    wave1 = r1[n1.index("waveform")]
    dur = r1[n1.index(tensor_name)]
    assert wave0.shape == wave1.shape and (wave0 == wave1).all(), "waveform changed!"
    total = float(dur.sum())
    print(f"waveform identical: {wave1.shape}, {wave1.size / 24000:.2f}s @24kHz")
    print(f"durations: shape {dur.shape}, sum {total:.1f} frames")
    if total > 0:
        print(f"samples per duration frame: {wave1.size / total:.2f} "
              f"(use audio_samples / dur.sum() at runtime — self-calibrating, no magic constant)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="onnx-community/Kokoro-82M-v1.0-ONNX")
    ap.add_argument("--file", default="onnx/model_quantized.onnx")
    ap.add_argument("--model-path", help="local .onnx path (skips download)")
    ap.add_argument("--tensor", help="explicit tensor name to expose")
    ap.add_argument("--as", dest="out_name", default="pred_dur",
                    help="name for the new graph output (default: pred_dur)")
    ap.add_argument("--list", action="store_true", help="list candidates and exit")
    ap.add_argument("--out", default="model_timestamped.onnx")
    ap.add_argument("--verify", action="store_true")
    args = ap.parse_args()

    model, src_path = load_model(args)
    chain = find_rounded_duration(model)
    if args.list:
        print(f"chain match (Round->Clip->...->CumSum): {chain or 'NOT FOUND'}")
        cands = duration_candidates(model)
        print(f"{'score':>5}  {'op':<6} tensor  (consumers)")
        for score, name, op, cons in cands[:20]:
            print(f"{score:>5}  {op:<6} {name}  ({cons})")
        return 0

    tensor = args.tensor or chain
    if not tensor:
        print("duration chain not found — inspect the graph in Netron and pass --tensor")
        return 1
    print(f"exposing: {tensor}" + ("" if args.tensor else "  (matched Round->Clip->...->CumSum chain)"))
    expose(model, tensor, args.out, args.out_name)
    if args.verify:
        verify(src_path, args.out, args.out_name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
