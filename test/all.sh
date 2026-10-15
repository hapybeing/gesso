#!/bin/sh
# Run the browser tests; fail if any reports console errors or exits non-zero.
# The whole suite takes ~9 min under SwiftShader, so it is split into groups that each fit a 2-minute shell:
#   test/all.sh 1 … test/all.sh 13     (no argument = everything); GESSO_T=<s> raises the per-test timeout
#   (the shared CI box can be 10× slower than an idle one — run groups in the background there)
cd "$(dirname "$0")/.." || exit 1
case "$1" in
  1) set -- run r1 m2 gessofile ;;
  2) set -- quickshape symmetry transform selection ;;
  3) set -- bigdoc ;;
  4) set -- timelapse warp ;;
  5) set -- anim ;;
  6) set -- tiles ;;
  7) set -- groups adjust wet ;;
  9) set -- m5a ;;
  10) set -- guides ;;
  11) set -- fill palette ;;
  12) set -- animpro tween ;;
  13) set -- productivity ;;
  8) set -- feel text ;;
  *) set -- run r1 m2 gessofile quickshape symmetry transform selection bigdoc timelapse warp anim tiles groups adjust wet feel text m5a guides fill palette animpro tween productivity ;;
esac
fail=0
[ "$1" = run ] && { node test/quickshape-unit.cjs | tail -1 || fail=1; }
for t in "$@"; do [ -f test/$t-unit.cjs ] && [ $t != quickshape ] && { u=$(node test/$t-unit.cjs 2>&1) || fail=1; echo "$u" | tail -1; }; done
for t in "$@"; do
  [ -f test/$t.cjs ] || { echo "$t: missing"; continue; }
  out=$(timeout ${GESSO_T:-115} node test/$t.cjs 2>&1); code=$?
  last=$(echo "$out" | grep -E "^errors:" | tail -1)
  [ $code -eq 124 ] && pkill -f 'chrome.*swiftshader' 2>/dev/null   # a timed-out test leaves its browser behind
  echo "$t: exit $code, $last"
  [ $code -ne 0 ] && fail=1
  echo "$last" | grep -q "errors: none" || fail=1
done
exit $fail
