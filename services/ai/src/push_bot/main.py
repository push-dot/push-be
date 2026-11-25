"""push-bot's API: every /api/v1 route the AI side answers for the app and the personal web chat."""

from app.main import create_app

app = create_app(audience="personal")
