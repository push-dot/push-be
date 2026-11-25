"""push-agent's API: a company conversation's read routes, the chat wake and /healthz.

Employer turns arrive as queue jobs, so there is no employer-only route.
"""

from app.api.routers import conversations
from app.main import create_app
from push_agent.harness.spec import register

register()
app = create_app(routers=(conversations.router,), audience="company")
