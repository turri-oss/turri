#!/usr/bin/env bash

UNRECOVERABLE_ERROR_EXIT_CODE=69

# Check if build folder name is provided
if [ -z "$1" ]; then
  printf "Error: No build folder name provided.\n"
  printf "Usage: $0 <build_folder_name> <conformance_tests_folder>\n"
  exit $UNRECOVERABLE_ERROR_EXIT_CODE
fi

# Check if conformance tests folder name is provided
if [ -z "$2" ]; then
  printf "Error: No conformance tests folder name provided.\n"
  printf "Usage: $0 <build_folder_name> <conformance_tests_folder>\n"
  exit $UNRECOVERABLE_ERROR_EXIT_CODE
fi

# A Python interpreter that runs: python3 first, then python. Found on the PATH is not enough - on Windows python3 may
# be the Microsoft Store's stand-in, which runs nothing.
PYTHON_CMD=""
for candidate in python3 python; do
    if "$candidate" -c "import sys" >/dev/null 2>&1; then
        PYTHON_CMD="$candidate"
        break
    fi
done
if [ -z "$PYTHON_CMD" ]; then
    printf "Error: Python interpreter not found. Please install Python.\n"
    exit $UNRECOVERABLE_ERROR_EXIT_CODE
fi

# Resolve the conformance tests folder to an absolute path so it can be used
# after changing into the working folder ($2 may be relative to the invocation
# directory on older harnesses; turri passes it as an absolute path - on Windows
# C:/Users/..., which a test for a leading / would take for a relative one).
CONFORMANCE_TESTS_FOLDER="$(cd "$2" 2>/dev/null && pwd)" || {
    printf "Error: the conformance tests folder '%s' does not exist.\n" "$2"
    exit 2
}

# Conformance tests live in the conformance tests folder and nowhere else. One in the
# build folder is in the wrong place: nothing would run it as part of the suite. Refuse.
MISPLACED=$( (grep -rlE --exclude=".turri*" --exclude-dir=.venv --exclude-dir=node_modules --exclude-dir=target \
    "(conformance tests|(conformance|acceptance) scenario [a-z0-9-]+) of [^[:space:]:]+:[a-z0-9-]+" "$1" 2>/dev/null; \
  find "$1" -type f \( -ipath "*conformance*" -o -ipath "*acceptance*" \) -iname "*test*" \
    -not -name ".turri*" -not -path "*/.venv/*" -not -path "*/node_modules/*" -not -path "*/target/*" 2>/dev/null) | sort -u)
if [ -n "$MISPLACED" ]; then
  printf "Error: conformance tests found in the build folder %s - they belong in the conformance tests folder %s:\n%s\n" "$1" "$CONFORMANCE_TESTS_FOLDER" "$MISPLACED" >&2
  exit 1
fi

# Working folder lives in the system temp directory. $1 may be an absolute
# path, so only its basename is used to build the working folder name.
PYTHON_BUILD_SUBFOLDER="/tmp/python_$(basename "$1")"

trap 'rm -rf "$PYTHON_BUILD_SUBFOLDER"' EXIT

if [ "${VERBOSE:-}" -eq 1 ] 2>/dev/null; then
  printf "Preparing Python build subfolder: $PYTHON_BUILD_SUBFOLDER\n"
fi

rm -rf "$PYTHON_BUILD_SUBFOLDER"
mkdir -p "$PYTHON_BUILD_SUBFOLDER"

cp -R "$1"/* "$PYTHON_BUILD_SUBFOLDER"

# Move to the subfolder
if ! cd "$PYTHON_BUILD_SUBFOLDER" 2>/dev/null; then
  printf "Error: Python build folder '$PYTHON_BUILD_SUBFOLDER' does not exist.\n"
  exit $UNRECOVERABLE_ERROR_EXIT_CODE
fi

printf "Creating the virtual environment...\n"

# Time the virtual environment's setup: bash's own SECONDS, as `date +%N` is GNU's alone and bc is not everywhere.
SECONDS=0

VENV_DIR=".venv"

if ! "$PYTHON_CMD" -m venv "$VENV_DIR"; then
    printf "Error: Failed to create virtual environment in '$VENV_DIR'.\n"
    exit $UNRECOVERABLE_ERROR_EXIT_CODE
fi

# The venv's own tools, called by path rather than activated: in bin/ on macOS and Linux, in Scripts/ on Windows.
if [ -d "$VENV_DIR/Scripts" ]; then VENV_BIN="$VENV_DIR/Scripts"; else VENV_BIN="$VENV_DIR/bin"; fi
VENV_PYTHON="$VENV_BIN/python"
printf "Virtual environment: %s (%s)\n" "$VENV_DIR" "$("$VENV_PYTHON" --version 2>&1)"

# Install requirements if requirements.txt exists
if [ -f "requirements.txt" ]; then
    "$VENV_PYTHON" -m pip install --upgrade pip
    "$VENV_PYTHON" -m pip install -r requirements.txt || exit $?
else
    echo "Warning: requirements.txt not found. Cannot proceed with setting up requirements. The requirements may also already be installed"
fi

printf "Requirements setup completed in %d seconds\n\n" "$SECONDS"

# Static checks of the conformance tests - and only them - in the environment they run in, the build installed: ruff's
# formatter in check mode, ruff's linter and mypy with a tests profile. The settings are pinned here, in a config the
# script writes into the working folder; none is read from the tests folder, whose files the conformance agent writes.
STATIC_CHECKS_FAILED=80
printf "Static checks of the conformance tests in %s...\n" "$CONFORMANCE_TESTS_FOLDER"
echo "+ $VENV_PYTHON -m pip install ruff mypy"
"$VENV_PYTHON" -m pip install ruff mypy || exit $?
cat > .conformance-mypy.ini <<'INI'
[mypy]
disallow_untyped_defs = True
follow_imports = silent
ignore_missing_imports = True
INI
CHECKS=0
echo "+ ruff format --check --no-cache --isolated --output-format concise $CONFORMANCE_TESTS_FOLDER"
"$VENV_BIN/ruff" format --check --no-cache --isolated --output-format concise "$CONFORMANCE_TESTS_FOLDER" || CHECKS=1
echo "+ ruff check --no-cache --isolated --output-format concise --no-fix $CONFORMANCE_TESTS_FOLDER"
"$VENV_BIN/ruff" check --no-cache --isolated --output-format concise --no-fix "$CONFORMANCE_TESTS_FOLDER" || CHECKS=1
echo "+ mypy --config-file .conformance-mypy.ini --cache-dir ./.mypy_cache --no-color-output --show-column-numbers $CONFORMANCE_TESTS_FOLDER"
"$VENV_BIN/mypy" --config-file .conformance-mypy.ini --cache-dir ./.mypy_cache --no-color-output --show-column-numbers "$CONFORMANCE_TESTS_FOLDER" || CHECKS=1
[ "$CHECKS" -eq 0 ] && printf "Static checks: passed\n\n" || printf "Static checks: FAILED - the findings are above\n\n"

# Execute all Python conformance tests in the build folder - whatever the checks said, so one run reports both
printf "Running Python conformance tests...\n\n"

output=$("$VENV_PYTHON" -m unittest discover -b -s "$CONFORMANCE_TESTS_FOLDER" 2>&1)
exit_code=$?

# Echo the original output
echo "$output"

# Check if no tests were discovered
if echo "$output" | grep -q "Ran 0 tests in"; then
    printf "\nError: No unittests discovered.\n"
    exit 1
fi

# The suite's own exit code when it failed; 80 when only the static checks of the tests did; 0 when both pass
if [ "$exit_code" -ne 0 ]; then
    exit $exit_code
fi
if [ "$CHECKS" -ne 0 ]; then
    printf "\nThe conformance tests pass, and their static checks do not.\n"
    exit $STATIC_CHECKS_FAILED
fi
exit 0