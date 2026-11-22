"""Verify the sample chain of an exported station bench report, offline."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from vihanga.bench import verify_samples

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("report", type=Path)
parser.add_argument("--head", help="Independently retained capture checkpoint")
args = parser.parse_args()
try:
    report = json.loads(args.report.read_text(encoding="utf-8"))
    seal = report["ledger"]
    valid = (seal["format"] == "vihanga.bench.v1"
             and verify_samples(report["capture"], report["samples"], seal["sample_count"], seal["head"])
             and (args.head is None or args.head == seal["head"]))
except (OSError, KeyError, ValueError, TypeError) as exc:
    parser.exit(1, f"Cannot verify report: {exc}\n")
if not valid:
    parser.exit(1, "Sample chain mismatch.\n")
print("Sample chain matches " + ("the independently supplied checkpoint." if args.head else "the checkpoint in this export."))
