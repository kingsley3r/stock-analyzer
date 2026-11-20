from analyzer import indicators as ind


def test_pct_change():
    assert round(ind.pct_change([100, 110], 1), 6) == 10
    assert ind.pct_change([100], 1) is None


def test_sma():
    assert ind.sma([1, 2, 3, 4], 2) == 3.5
    assert ind.sma([1], 2) is None


def test_rsi_extremes():
    rising = list(range(1, 40))
    falling = list(range(40, 1, -1))
    assert ind.rsi(rising) == 100.0
    assert ind.rsi(falling) < 1
    assert ind.rsi([1, 2]) is None


def test_rsi_known_value():
    # Classic example data (Wilder); result should be near 70.5 for the first RSI value.
    closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
              45.89, 46.03, 45.61, 46.28, 46.28]
    assert 70 < ind.rsi(closes) < 71


def test_volume_ratio():
    vols = [100] * 20 + [300]
    assert ind.volume_ratio(vols) == 3.0
