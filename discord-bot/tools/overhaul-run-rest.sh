#!/usr/bin/env bash
# Sequentially run Phase 4 → 5 → 6 of the asset overhaul.
# Each phase: generate, upload, log result. Re-runnable (generator
# skips existing files; uploader is idempotent).
#
# Run from discord-bot/:
#   REPLICATE_API_TOKEN=... bash tools/overhaul-run-rest.sh
set -u
export PYTHONIOENCODING=utf-8

LOG=/c/tmp/pixel-art-overhaul/_run.log
mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1

echo
echo "=================================================="
echo "Asset overhaul Phase 4-6 sequential run started $(date)"
echo "=================================================="

for phase in gear clash pets; do
  echo
  echo "----- Phase: $phase -----"
  echo "  generate ..."
  python tools/overhaul-generate.py "$phase" --no-pacing
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "  generate FAILED (rc=$rc) — continuing to upload partial"
  fi
  echo "  upload ..."
  python tools/overhaul-upload.py "$phase"
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "  upload FAILED (rc=$rc)"
  fi
done

echo
echo "=================================================="
echo "All phases complete at $(date)"
echo "=================================================="
