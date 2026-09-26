import unittest

from powerrank import parse_directory_names, parse_members


class DirectoryParserTests(unittest.TestCase):
    def test_alphabet_navigation_is_not_a_character(self):
        page = '<a href="/userfiles/a.html">A</a><a href="http://users.nexustk.com/?name=aeza">Muse aeza</a>'
        self.assertEqual(parse_directory_names(page), {"aeza": {"name": "aeza", "title": "Muse"}})

    def test_member_mark_activity_and_unregistered_icon(self):
        page = ('<span class="big"><LI> Guide: </span>'
                '<a class="link" href="http://users.nexustk.com/?name=brine">Brine (Survivalist - Sam San)</a>'
                '<IMG SRC="buttonred.gif" ALT="Absent"><IMG SRC="Notreg.gif" ALT="Unregistered"><BR>'
                '<a href="http://users.nexustk.com/?name=lapin">Lapin (Sonbae - Il San) "Oh Bother..."</a>'
                '<IMG SRC="buttongreen.gif" ALT="Active"><BR>')
        parsed = parse_members(page)
        self.assertEqual(parsed["brine"], {"name": "Brine", "level_mark": "Sam San", "activity": "absent", "registration": "unregistered"})
        self.assertEqual(parsed["lapin"]["level_mark"], "Il San")
        self.assertEqual(parsed["lapin"]["registration"], "registered")


if __name__ == "__main__":
    unittest.main()
