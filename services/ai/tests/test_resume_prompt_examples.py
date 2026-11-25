import re

from app.harness.personal.resume.graph import phase_instructions


def test_analyze_prompt_examples_name_only_the_placeholder_account():
    prompt = phase_instructions("analyze", {})
    owners = re.findall(r"(?<![.\w])github\.com/([A-Za-z0-9-]+)", prompt)
    owners += re.findall(r'"(?:username|full_name)":\s*"([A-Za-z0-9-]+)', prompt)

    assert "example-user" in owners
    assert set(owners) == {"example-user"}
