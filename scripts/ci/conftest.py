"""The safety-system tests must never touch the repository they run in.

Git exports GIT_DIR (and, depending on the hook and the worktree layout, several
related variables) to every hook it runs. The pre-push gate runs these tests; the
tests build throwaway repositories with plain `git init` / `git commit` /
`git config`, and a subprocess inherits the environment. With GIT_DIR set, every
one of those commands operated on the REAL repository instead of the throwaway
one: the branch being pushed was deleted, `core.bare` was set on the shared
config (breaking every other worktree), and `user.name` became `t`.

`.githooks/pre-push` and `scripts/ci/preflight.sh` unset these first. This is the
last line of defence, for any other way the tests get launched from inside git.
"""
import os

#: Repository-locating variables. Any one of them re-targets a child `git`.
GIT_LOCATION_VARS = (
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
)


def pytest_configure(config):
    for name in GIT_LOCATION_VARS:
        os.environ.pop(name, None)
