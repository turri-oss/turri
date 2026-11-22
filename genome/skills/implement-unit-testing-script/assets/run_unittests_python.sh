#!/usr/bin/env bash
# The unit tests of a Python build, with its static checks: ruff's formatter in check mode, ruff's linter and mypy,
# each from the project's own `dev` dependency group, then pytest - as stdlib/lang/python asks for them.
#
#   run_unittests_python.sh <build folder>
#
# The build folder is read only: the build is staged in a working folder in /tmp and everything runs there.
# Every check runs, and the tests run whatever the checks said, so one run reports both.
# Exit codes: 0 all pass; 1 bad usage; 2 a filesystem problem; 69 a toolchain missing on this machine;
# 80 the tests passed and only the static checks did not; any other, the failing install or test tool's own.

set -u
STATIC_CHECKS_FAILED=80

echo "===== [1/8] Toolchain check ====="
if ! command -v uv >/dev/null 2>&1; then
  echo "Error: uv is not installed on this machine (https://docs.astral.sh/uv/)."
  exit 69
fi
echo "uv: $(command -v uv) - $(uv --version)"
PYTHON="$(uv python find --system --no-python-downloads 3.12 2>/dev/null)" || {
  echo "Error: Python 3.12 is not installed on this machine; no runtime is downloaded."
  exit 69
}
echo "Python: $PYTHON - $("$PYTHON" --version 2>&1)"

echo "===== [2/8] Argument validation ====="
if [ -z "${1:-}" ]; then
  echo "Usage: $0 <build folder>"
  exit 1
fi
SOURCE="$(cd "$1" 2>/dev/null && pwd)" || { echo "Error: the build folder '$1' does not exist."; exit 2; }
echo "Build folder (read only): $SOURCE"

echo "===== [3/8] Working folder ====="
# A folder of its own each run: runs side by side never share one.
WORKING_FOLDER="$(mktemp -d "/tmp/python_$(basename "$SOURCE").XXXXXX")" || { echo "Error: could not create a working folder in /tmp."; exit 2; }
trap 'rm -rf "$WORKING_FOLDER"' EXIT
echo "Working folder: $WORKING_FOLDER"

echo "===== [4/8] Copy the build ====="
EXCLUDES=(--exclude=.venv --exclude=venv --exclude=__pycache__ --exclude=.mypy_cache --exclude=.ruff_cache --exclude=.pytest_cache --exclude=.git)
echo "+ tar -C $SOURCE ${EXCLUDES[*]} -cf - . | tar -C $WORKING_FOLDER -xf -"
tar -C "$SOURCE" "${EXCLUDES[@]}" -cf - . | tar -C "$WORKING_FOLDER" -xf - || { echo "Error: could not copy the build folder."; exit 2; }

echo "===== [5/8] Enter the working folder ====="
cd "$WORKING_FOLDER" 2>/dev/null || { echo "Error: cannot enter $WORKING_FOLDER."; exit 2; }
echo "Now in: $(pwd)"

echo "===== [6/8] Dependencies ====="
if [ ! -f pyproject.toml ]; then
  echo "Error: there is no pyproject.toml - the project's dependencies, pytest, ruff and mypy among them, go in it."
  exit 1
fi
# Relative to the working folder, where the script now is: a path a native Windows uv reads as it is, from Git Bash too.
export UV_PROJECT_ENVIRONMENT=".venv" UV_PYTHON="$PYTHON" UV_PYTHON_DOWNLOADS=never
export UV_CACHE_DIR="${UV_CACHE_DIR:-.uv-cache}" PYTHONDONTWRITEBYTECODE=1
unset PYTHONPATH PYTHONHOME
echo "+ uv sync (the project and its dev dependency group into $WORKING_FOLDER/.venv)"
uv sync || exit $?
# The venv's own tools: in bin/ on macOS and Linux, in Scripts/ on Windows.
if [ -d .venv/Scripts ]; then VENV_BIN=.venv/Scripts; else VENV_BIN=.venv/bin; fi

echo "===== [7/8] Static checks ====="
CHECKS=0
for tool in ruff mypy; do
  if [ ! -x "$VENV_BIN/$tool" ]; then
    echo "pyproject.toml:1:1: $tool is not in the dev dependency group - add it with \`uv add --dev $tool\`"
    CHECKS=1
  fi
done
if [ -x "$VENV_BIN/ruff" ]; then
  # Not uv's cache, kept in the working folder when the person has none of their own: its files are not the build's.
  echo "+ ruff format --check --output-format concise --extend-exclude .uv-cache ."
  "$VENV_BIN/ruff" format --check --output-format concise --extend-exclude .uv-cache . || CHECKS=1
  echo "+ ruff check --output-format concise --no-fix --extend-exclude .uv-cache ."
  "$VENV_BIN/ruff" check --output-format concise --no-fix --extend-exclude .uv-cache . || CHECKS=1
fi
if [ -x "$VENV_BIN/mypy" ]; then
  # `files` in [tool.mypy] says what to check; without it, the whole build.
  if grep -Eq '^[[:space:]]*files[[:space:]]*=' pyproject.toml; then TARGETS=(); else TARGETS=(.); fi
  echo "+ mypy --no-color-output --show-column-numbers ${TARGETS[*]:-}"
  "$VENV_BIN/mypy" --no-color-output --show-column-numbers ${TARGETS[@]+"${TARGETS[@]}"} || CHECKS=1
fi
[ "$CHECKS" -eq 0 ] && echo "Static checks: passed" || echo "Static checks: FAILED - the findings are above"

echo "===== [8/8] Unit tests ====="
echo "+ uv run --no-sync pytest"
uv run --no-sync pytest
TESTS=$?

echo "===== Summary ====="
if [ "$TESTS" -ne 0 ]; then
  STATUS=$TESTS
elif [ "$CHECKS" -ne 0 ]; then
  STATUS=$STATIC_CHECKS_FAILED
else
  STATUS=0
fi
echo "static checks: $([ "$CHECKS" -eq 0 ] && echo passed || echo failed); unit tests: exit $TESTS"
echo "Exit: $STATUS; build: $SOURCE; working folder: $WORKING_FOLDER"
exit "$STATUS"
