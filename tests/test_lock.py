import pytest
from cryptography.exceptions import InvalidTag

from analyzer.lock import Locker


def test_roundtrip_and_wrong_password():
    a = Locker("correct horse")
    sealed = a.seal({"x": [1, 2, "ü"]})
    assert '"x"' not in sealed["ct"]
    same = Locker("correct horse", salt=a.salt)
    assert same.open(sealed) == {"x": [1, 2, "ü"]}
    with pytest.raises(InvalidTag):
        Locker("wrong", salt=a.salt).open(sealed)
