"""BillingStore.list_ledger builds its SQL with Conds; CI PREPAREs what it sends."""
from uuid import uuid4

from app.domain.pagination import Cursor
from app.infrastructure.store_integrations import BillingStore
from tests.cov_fakes import NOW, USER, assert_scoped, fake_db, page


async def test_list_ledger_is_scoped_with_and_without_a_cursor():
    for cursor in (None, Cursor(NOW, uuid4())):
        db, conn = fake_db([])
        result = await BillingStore(db).list_ledger(USER, page(5, cursor))
        assert result.items == []
        _, sql, args = conn.last
        assert sql.startswith("SELECT id, user_id, type, amount_micro_credits")
        assert "FROM billing_ledger WHERE" in sql
        assert ("(created_at, id) <" in sql) is (cursor is not None)
        assert args[-1] == 6
        assert_scoped(conn.last, USER)
