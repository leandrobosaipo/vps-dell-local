import unittest
from provision import inspect


class ScopeTests(unittest.TestCase):
    def test_existing_dns_is_refused_without_mutation(self):
        calls = []
        class Fake:
            def request(self, path, method="GET", data=None):
                calls.append(method)
                if path.startswith('zones?'):
                    return [{'id':'z','status':'active','account':{'id':'a'}}]
                if '/dns_records?' in path:
                    return [{'id':'existing'}]
                return []
        with self.assertRaisesRegex(ValueError, 'already exist'):
            inspect(Fake(), {'zone':'codigo5.com.br','hostname':'painel-dell.codigo5.com.br',
                             'tunnelName':'vps-dell-local','serviceTokenName':'VPS Dell local - Dot'})
        self.assertTrue(calls)
        self.assertEqual(set(calls), {'GET'})

    def test_ambiguous_zone_is_refused(self):
        class Fake:
            def request(self, path):
                return []
        with self.assertRaisesRegex(ValueError, 'one active zone'):
            inspect(Fake(), {'zone':'codigo5.com.br'})


if __name__ == '__main__':
    unittest.main()
