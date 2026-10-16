"""Run with python3 .github/ci/test_workflow_jobs.py; no dependencies.

Reads ci.yml as text: these checks only need to know that a job exists and which
commands it runs, so they avoid a YAML dependency on the runner.
"""

import re
import unittest
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[1] / "workflows" / "ci.yml"


def job_block(name: str) -> str:
    text = WORKFLOW.read_text()
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)", text, re.S | re.M)
    if match is None:
        raise AssertionError(f"ci.yml has no job named {name!r}")
    return match.group(1)


class ContractDriftJobTest(unittest.TestCase):
    def test_job_runs_the_export_check(self):
        block = job_block("contract-drift")
        self.assertIn("backend/scripts/export_openapi.py --check", block)
        # The comparison must run on the locked dependency set, like the backend tests.
        self.assertIn("uv sync --locked", block)


class NodeBackendJobsTest(unittest.TestCase):
    def test_backend_node_tests_job_lints_typechecks_and_tests_with_coverage(self):
        block = job_block("backend-node-tests")
        for command in ("npm ci", "npm run lint", "npm run typecheck", "npm test -- --coverage"):
            self.assertIn(command, block)

    def test_contract_job_runs_the_suite_against_both_stacks(self):
        block = job_block("contract")
        self.assertRegex(block, r"stack:\s*\[python, node\]")
        self.assertIn("CONTRACT_STACK: ${{ matrix.stack }}", block)
        self.assertIn("node scripts/summary.mjs .logs/result.json --no-skip", block)

    def test_schema_diff_job_runs_the_script_with_its_self_test(self):
        block = job_block("schema-diff")
        self.assertIn("backend-node/scripts/schema-diff.sh --self-test", block)


class ChangesWiringTest(unittest.TestCase):
    def test_new_jobs_read_run_backend_node(self):
        for name in ("backend-node-tests", "contract", "schema-diff"):
            with self.subTest(job=name):
                self.assertIn("steps.changes.outputs.run_backend_node", job_block(name))
                self.assertIn("python3 .github/ci/changes.py", job_block(name))

    def test_contract_and_schema_diff_also_run_for_backend_changes(self):
        for name in ("contract", "schema-diff"):
            with self.subTest(job=name):
                self.assertIn("steps.changes.outputs.run_backend ", job_block(name) + " ")


if __name__ == "__main__":
    unittest.main()
