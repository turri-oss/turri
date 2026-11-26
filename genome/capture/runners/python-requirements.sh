#!/usr/bin/env bash
# Self-contained runner for a Python project run from its root. Inputs are read-only.
set -eu -o pipefail
mode='@MODE@'; build_var='@BUILD_VAR@'; python_var='@PYTHON_VAR@'
if [[ $mode == unit ]]; then [[ $# == 1 ]] || exit 1; else [[ $# == 2 ]] || exit 69; fi
src=$(cd "$1" && pwd) || exit 2
if [[ $mode != unit ]]; then
  tests=$(cd "$2" && pwd) || exit 2
  misplaced=$(grep -rlE --exclude='.turri*' --exclude-dir=.venv --exclude-dir=.git '(conformance tests|(conformance|acceptance) scenario [a-z0-9-]+) of [^[:space:]:]+:[a-z0-9-]+' "$src" || true
    find "$src" -type f \( -ipath '*conformance*' -o -ipath '*acceptance*' \) -iname '*test*' ! -name '.turri*')
  if [[ -n $misplaced ]]; then echo "Conformance tests belong in $tests, not the build: $misplaced"; exit 1; fi
fi
work=$(mktemp -d "${TMPDIR:-/tmp}/turri-tests.XXXXXXXX") || exit 2
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/build" "$work/tmp"
tar -C "$src" --exclude=.git --exclude=.venv --exclude=__pycache__ -cf - . | tar -C "$work/build" -xf - || exit 2
cd "$work/build"
export TMPDIR="$work/tmp" PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1
unset PYTHONPATH PYTHONHOME
for py in python3 python; do "$py" -c 'import sys; assert sys.version_info.major == 3' 2>/dev/null && break; done
"$py" -m venv "$work/venv" || { echo 'Python 3 with venv is required'; exit 69; }
bin="$work/venv/bin"; [[ -d "$bin" ]] || bin="$work/venv/Scripts"
export PATH="$bin:$PATH"
if [[ '@INSTALL@' == package ]]; then
  "$bin/python" -m pip install --cache-dir "$work/pip" '@EXTRA@' || exit $?
else
  "$bin/python" -m pip install --cache-dir "$work/pip" -r requirements.txt || exit $?
fi
[[ -z $build_var ]] || export "$build_var=$PWD"
[[ -z $python_var ]] || export "$python_var=$bin/python"
checks=0
if [[ $mode == bats ]]; then
  if ! command -v bats >/dev/null; then
    git clone -q --depth 1 --branch v1.12.0 https://github.com/bats-core/bats-core.git "$work/bats" || exit 69
    export PATH="$work/bats/bin:$PATH"
  fi
  # Bats preprocessing checks the suite's shell syntax. Count first: zero tests must never pass.
  count=$(bats --recursive --count "$tests") || exit 1
  [[ $count =~ ^[1-9][0-9]*$ ]] || { echo 'No Bats tests discovered'; exit 1; }
  bats --recursive --formatter tap "$tests"
else
  if [[ '@CHECKS@' == black ]]; then
    "$bin/python" -m pip install --cache-dir "$work/pip" pytest black isort flake8 mypy || exit $?
    target=.; [[ $mode == unit ]] || target=$tests
    "$bin/python" -m black --check --config pyproject.toml "$target" || checks=80
    "$bin/python" -m isort --check-only --settings-path pyproject.toml "$target" || checks=80
    "$bin/python" -m flake8 --isolated "$target" || checks=80
  else
    "$bin/python" -m pip install --cache-dir "$work/pip" pytest ruff mypy || exit $?
  fi
  if [[ $mode == unit ]]; then
    if [[ '@CHECKS@' != black ]]; then
      "$bin/python" -m ruff format --check . || checks=80
      "$bin/python" -m ruff check . || checks=80
    fi
    "$bin/python" -m mypy . || checks=80
    "$bin/python" -m pytest
  else
    if [[ '@CHECKS@' != black ]]; then
      "$bin/python" -m ruff format --check --isolated --no-cache "$tests" || checks=80
      "$bin/python" -m ruff check --isolated --no-cache "$tests" || checks=80
    fi
    "$bin/python" -m mypy --config-file= --disallow-untyped-defs --follow-imports=silent "$tests" || checks=80
    "$bin/python" -m pytest -c /dev/null -p no:cacheprovider --basetemp="$work/pytest" "$tests"
  fi
fi
exit "$checks"
