import time

from analyzer import inbox, news, prices, youtube

NOW = time.time()
RFC = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(NOW - 3600))
OLD = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(NOW - 5 * 86400))
ISO = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(NOW - 3600))

RSS = f"""<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Nvidia beats &amp; raises</title><link>https://x/1</link>
<description>&lt;p&gt;Strong &lt;b&gt;quarter&lt;/b&gt;&lt;/p&gt;</description><pubDate>{RFC}</pubDate></item>
<item><title>Old story</title><link>https://x/2</link><pubDate>{OLD}</pubDate></item>
</channel></rss>"""

YT = f"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
<entry><yt:videoId>abcdefghijk</yt:videoId><title>Markets rally on Fed</title>
<link rel="alternate" href="https://www.youtube.com/watch?v=abcdefghijk"/>
<published>{ISO}</published>
<media:group><media:title>Markets rally on Fed</media:title>
<media:description>Today we look at the Fed decision.</media:description>
<media:community><media:starRating count="1234" average="5.00" min="1" max="5"/><media:statistics views="56789"/></media:community>
</media:group><author><name>CNBC Television</name></author></entry>
</feed>"""


def test_parse_rss_filters_old_and_strips_html():
    items = news.parse_feed(RSS, "Test", since=NOW - 86400)
    assert [a.title for a in items] == ["Nvidia beats & raises"]
    assert items[0].summary == "Strong quarter"


def test_parse_youtube_feed_has_description():
    items = news.parse_feed(YT, "chan", since=NOW - 86400)
    assert len(items) == 1
    assert items[0].summary == "Today we look at the Fed decision."
    assert youtube.video_id_from_link(items[0].link) == "abcdefghijk"


def test_dedupe_keeps_newest():
    a = news.Article("A", "Same Title!", "l1", "", 1)
    b = news.Article("B", "same title", "l2", "", 2)
    assert [x.source for x in news.dedupe([a, b])] == ["B"]


def test_strip_tags():
    assert inbox.strip_tags('<b>Hi</b> &amp; <a href="x">link</a>') == "Hi & link"


def test_build_snapshot():
    closes = [100 + i for i in range(60)]
    snap = prices.build_snapshot("TEST", "Test", "stock", ["ai"], closes, [1000] * 60, "2026-11-19")
    assert snap.last == 159
    assert round(snap.change_1d, 2) == round((159 / 158 - 1) * 100, 2)
    assert snap.vs_sma50 > 0 and snap.vs_sma200 is None
    assert snap.to_dict()["tags"] == ["ai"]


def test_parse_channel_feed_views_and_likes():
    vids = youtube.parse_channel_feed(YT, "CNBCtelevision", "news", since=NOW - 86400)
    assert len(vids) == 1
    v = vids[0]
    assert (v.views, v.likes, v.video_id, v.channel_title) == (56789, 1234, "abcdefghijk", "CNBC Television")
    assert v.description == "Today we look at the Fed decision."
