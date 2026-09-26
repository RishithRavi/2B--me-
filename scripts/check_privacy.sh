#!/usr/bin/env bash
# Privacy boundary check (§2.2). Part of scripts/gate.sh; fails the merge on any hit.
#
# Fails on: kCGWindowName, event.key / keyCode / charCode / which (browser), clipboardData /
# navigator.clipboard, InputEvent / nativeEvent.data, bundleIdentifier outside a line tagged
# `privacy-ok: category-map`, raw keycodes reaching a logger / serializer / transport, forbidden keys
# in committed event fixtures, audio outside tests/fixtures/synthetic/, and .env / data/ in git.
#
# Escape hatch for a reviewed line: append `privacy-ok: <reason>` (e.g. the single capture-thread
# line that reads the keycode to map it to a key class). Claude reviews every such tag at merge.
# bash 3.2-compatible (macOS): no mapfile.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
red() { printf '\033[31m%s\033[0m\n' "$*"; }
hit() { red "PRIVACY: $1"; printf '%s\n' "$2" | sed 's/^/    /'; fail=1; }

CODE=(); PY=(); WEB=()
while IFS= read -r f; do
  [ -f "$f" ] || continue
  CODE+=("$f")
  case "$f" in
    *.py) PY+=("$f") ;;
    *.ts|*.tsx|*.js|*.jsx|*.mjs) WEB+=("$f") ;;
  esac
done < <(git ls-files --cached --others --exclude-standard -- \
  '*.py' '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.swift' '*.sh' \
  ':!:scripts/check_privacy.sh' ':!:**/node_modules/**' ':!:web/src/lib/contracts.ts' \
  ':!:**/*.test.ts' ':!:**/*.test.tsx' ':!:**/tests/test_privacy*.py' ':!:web/.next/**' ':!:web/out/**' 2>/dev/null)

scan() {  # scan <label> <regex> <files...>
  local label="$1" re="$2"; shift 2
  [ "$#" -eq 0 ] && return 0
  local out
  out=$(grep -nE "$re" "$@" 2>/dev/null | grep -v 'privacy-ok:' || true)
  if [ -n "$out" ]; then hit "$label" "$out"; fi
  return 0
}

ALL=${CODE[@]+"${CODE[@]}"}

# 1. window titles never read
scan "kCGWindowName (window titles) must never be read" 'kCGWindowName' ${CODE[@]+"${CODE[@]}"}

# 2. browser key identities / content
scan "event.key / keyCode / charCode / which must never be read in the browser" \
  '\b(e|ev|evt|event|ke|keyEvent|nativeEvent)\.(key|keyCode|charCode|which)\b' ${WEB[@]+"${WEB[@]}"}
scan "reading the clipboard is forbidden" '(clipboardData|navigator\.clipboard\.read)' ${CODE[@]+"${CODE[@]}"}
scan "InputEvent content (.data) is forbidden" '(\bInputEvent\b|nativeEvent\.data\b|\binputType\b)' \
  ${WEB[@]+"${WEB[@]}"}

# 3. bundle IDs: only on the reviewed category-mapping line
scan "bundleIdentifier outside the category map (tag the mapping line with privacy-ok: category-map)" \
  'bundleIdentifier' ${CODE[@]+"${CODE[@]}"}

# 4. keycodes / bundle ids / titles reaching a logger, serializer or transport
scan "keycode / bundle id / window title reaching a logger, serializer or transport" \
  '(log(ger)?\.[a-z]+|print|json\.dumps?|orjson\.dumps|\.send(_text|_json)?|\.write|emit|console\.(log|info|warn|error)|JSON\.stringify)\(.*\b(key_?code|keycode|kVK_|bundle_?id|bundle_?identifier|window_?(name|title)|kCGKeyboardEventKeycode)\b' \
  ${CODE[@]+"${CODE[@]}"}
scan "keycode / bundle id / title stored under a serializable key" \
  "[\"'](keycode|key_code|kc|bundle_id|bundleId|window_title|window_name)[\"']\s*:" ${PY[@]+"${PY[@]}"}

# 5. committed event fixtures carry only class-level fields
if ls contracts/fixtures/events/*.jsonl >/dev/null 2>&1; then
  out=$(grep -nE '"(keycode|key_code|key|code|char|text|title|bundle|bundle_id|url|window_name)"\s*:' \
        contracts/fixtures/events/*.jsonl | head -5 || true)
  if [ -n "$out" ]; then hit "forbidden field in committed event fixtures" "$out"; fi
fi

# 6. wire fixtures (ticks) carry no coordinates / identities
out=$(grep -nE '"(keycode|x_pt|y_pt|title|bundle_id|url|cls|slot)"\s*:' contracts/fixtures/ticks/*.json 2>/dev/null || true)
if [ -n "$out" ]; then hit "forbidden field in tick fixtures" "$out"; fi

# 7. no audio outside tests/fixtures/synthetic/, no .env, no data/, no local behavior logs
out=$(git ls-files --cached -- '*.wav' '*.mp3' '*.webm' '*.flac' '*.m4a' | grep -v 'tests/fixtures/synthetic/' || true)
if [ -n "$out" ]; then hit "audio committed outside tests/fixtures/synthetic/" "$out"; fi
out=$(git ls-files --cached -- '.env' '**/.env' 'data/**' '*.pem' | grep -v '.env.example' || true)
if [ -n "$out" ]; then hit "secrets or data/ committed" "$out"; fi
out=$(git ls-files --cached | grep -E '(^|/)\.2bme/|/logs/.*\.jsonl$' || true)
if [ -n "$out" ]; then hit "local behavior logs committed" "$out"; fi

if [ "$fail" -ne 0 ]; then
  red "check_privacy: FAILED"
  exit 1
fi
echo "check_privacy: ok (${#CODE[@]} files scanned)"
