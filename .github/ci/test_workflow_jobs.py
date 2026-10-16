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


if __name__ == "__main__":
    unittest.main()
