"""This suite covers the shared package and both services.

push-agent registers its harness when it starts; the suite registers it once here so a test can run
a company conversation the way push-agent would.
"""

from push_agent.harness.spec import register

register()
