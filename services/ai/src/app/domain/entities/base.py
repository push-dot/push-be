from __future__ import annotations

from typing import ClassVar

from pydantic import BaseModel, ConfigDict, model_serializer
from pydantic.alias_generators import to_camel


class Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class OmitModel(Model):
    _omit_none: ClassVar[frozenset] = frozenset()

    @model_serializer(mode="wrap")
    def _ser(self, handler):
        d = handler(self)
        aliases = {n: (f.alias or n) for n, f in type(self).model_fields.items()}
        drop = {aliases[n] for n in self._omit_none} | set(self._omit_none)
        return {k: v for k, v in d.items() if v is not None or k not in drop}
