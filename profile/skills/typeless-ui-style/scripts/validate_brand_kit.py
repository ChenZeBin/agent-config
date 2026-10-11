#!/usr/bin/env python3
"""Validate the historical resource bundle. This does not test a native App."""
import hashlib
import json
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET

SKILL = Path(__file__).resolve().parents[1]
BUNDLE = SKILL / 'assets/mac-utility-brand-kit'


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in {'href', 'src'} and value:
                self.links.append(value)


def main():
    manifest = json.loads((BUNDLE / 'provenance.json').read_text())
    assert manifest['status'] == 'historical-design-proposal'
    entries = manifest['files']
    assert len(entries) == 17
    expected = {e['path'] for e in entries} | {'provenance.json'}
    actual = {str(p.relative_to(BUNDLE)) for p in BUNDLE.rglob('*') if p.is_file()}
    assert actual == expected, (actual - expected, expected - actual)
    for entry in entries:
        p = BUNDLE / entry['path']
        assert p.resolve().is_relative_to(BUNDLE.resolve()) and not p.is_symlink()
        data = p.read_bytes()
        assert hashlib.sha256(data).hexdigest() == entry['packaged_sha256'], p
        assert b'/Users/' not in data and b'file://' not in data, p
        if p.suffix in {'.svg', '.json'}:
            assert entry['source_sha256'] == entry['packaged_sha256'], p
        if p.suffix == '.svg':
            root = ET.fromstring(data)
            assert root.tag.endswith('}svg') and root.attrib.get('viewBox')
            for node in root.iter():
                tag = node.tag.rsplit('}', 1)[-1]
                assert tag not in {'script', 'foreignObject', 'image'}, (p, tag)
                for key, value in node.attrib.items():
                    assert not key.lower().startswith('on')
                    if key.rsplit('}', 1)[-1] == 'href':
                        assert value.startswith('#'), (p, value)
        if p.suffix == '.html':
            content = data.decode()
            assert '历史设计提案 · 品牌尚未确认' in content
            parser = Links()
            parser.feed(content)
            for link in parser.links:
                url = urlsplit(link)
                assert not url.scheme and not url.netloc, (p, link)
                if url.path:
                    target = (p.parent / unquote(url.path)).resolve()
                    assert target.is_relative_to(BUNDLE.resolve()) and target.is_file(), (p, link)
        if p.suffix == '.md':
            assert data.decode().startswith('> 历史设计提案')
    assert len(list(BUNDLE.rglob('*.svg'))) == 11
    assert len(list(BUNDLE.rglob('*.html'))) == 3
    tokens = json.loads((BUNDLE / 'tokens.json').read_text())
    assert tokens['status'] == 'design-proposal'
    assert tokens['ui']['colorPolicy'] == 'system-semantic-colors'
    assert 'not Apple mandatory' in tokens['note']
    reference = SKILL / 'references/mac-utility-brand-kit.md'
    assert reference.is_file()
    import re
    for link in re.findall(r'\]\(([^)]+)\)', reference.read_text()):
        assert (reference.parent / link).is_file(), link
    print(json.dumps({'static_bundle': 'passed', 'svg': 11, 'html': 3,
                      'native_app_tested': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
