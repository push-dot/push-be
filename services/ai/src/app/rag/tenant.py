from dataclasses import dataclass
from uuid import UUID


@dataclass(frozen=True)
class Tenant:
    user_id: UUID | None = None
    company_id: UUID | None = None

    def __post_init__(self):
        if self.user_id is None and self.company_id is None:
            raise ValueError("tenant requires a user_id or a company_id")
