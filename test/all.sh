#!/bin/sh
# Run every browser test; fail if any reports console errors or exits non-zero.
cd "$(dirname "$0")/.." || exit 1
fail=0
node test/quickshape-unit.cjs | tail -1 || fail=1
for t in run r1 m2 gessofile quickshape symmetry transform selection bigdoc; do
  out=$(timeout 115 node test/$t.cjs 2>&1); code=$?
  last=$(echo "$out" | grep -E "^errors:" | tail -1)
  echo "$t: exit $code, $last"
  [ $code -ne 0 ] && fail=1
  echo "$last" | grep -q "errors: none" || fail=1
done
exit $fail
