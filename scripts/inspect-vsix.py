#!/usr/bin/env python3
"""Inspect a VSIX without extracting archive paths or executing its contents."""
import json
import re
import stat
import struct
import sys
import zipfile
import xml.etree.ElementTree as ET

REQUIRED = {
    "[Content_Types].xml", "extension.vsixmanifest",
    "extension/LICENSE.txt", "extension/changelog.md", "extension/readme.md",
    "extension/dist/extension.js", "extension/language-configuration.json",
    "extension/media/icon.png", "extension/package.json",
    "extension/syntaxes/plan.tmLanguage.json",
}


def inspect(filename, version):
    with zipfile.ZipFile(filename) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)) or set(names) != REQUIRED:
            raise ValueError("VSIX content allowlist mismatch")
        if sum(entry.file_size for entry in entries) > 32 * 1024 * 1024:
            raise ValueError("VSIX uncompressed size exceeds limit")
        for entry in entries:
            if stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1:
                raise ValueError("VSIX contains links or encrypted files")
            data = archive.read(entry)
            if entry.filename != "extension/media/icon.png":
                text = data.decode("utf-8")
                if re.search(r"/Users/|/home/|[A-Z]:\\Users\\|github_pat_|ghp_|"
                             r"bnpm\.byted\.org|bytedance\.(net|com)|"
                             r"BEGIN .*PRIVATE KEY|target/planq", text):
                    raise ValueError("VSIX contains private content")
        manifest = json.loads(archive.read("extension/package.json"))
        expected = {
            "publisher": "planq-cli", "name": "planq", "version": version,
            "displayName": "PlanQ", "license": "PolyForm-Noncommercial-1.0.0",
            "icon": "media/icon.png", "main": "./dist/extension.js",
            "homepage": "https://planq.dev/docs/guides/editor-integration",
        }
        if any(manifest.get(key) != value for key, value in expected.items()):
            raise ValueError("VSIX package identity mismatch")
        if manifest.get("engines") != {"vscode": "^1.90.0"}:
            raise ValueError("VSIX engine mismatch")
        if "private" in manifest or manifest.get("galleryBanner") != {"color": "#24292f", "theme": "dark"}:
            raise ValueError("VSIX publication metadata mismatch")
        if manifest.get("repository") != {
            "type": "git", "url": "https://github.com/planq-cli/plan-releases.git"
        } or manifest.get("bugs") != {"url": "https://planq.dev/docs/troubleshooting"}:
            raise ValueError("VSIX public metadata mismatch")
        xml = archive.read("extension.vsixmanifest")
        if b"<!DOCTYPE" in xml or b"<!ENTITY" in xml:
            raise ValueError("VSIX manifest contains entity declarations")
        document = ET.fromstring(xml)
        identities = [node for node in document.iter()
                      if node.tag.rsplit("}", 1)[-1] == "Identity"]
        if len(identities) != 1 or any(identities[0].get(key) != value for key, value in {
            "Id": "planq", "Publisher": "planq-cli", "Version": version
        }.items()):
            raise ValueError("VSIX XML identity mismatch")
        if ("planq-cli.planq" not in archive.read("extension/readme.md").decode("utf-8")
                or not archive.read("extension/LICENSE.txt").startswith(b"# PolyForm Noncommercial License 1.0.0")
                or f"## {version} -" not in archive.read("extension/changelog.md").decode("utf-8")):
            raise ValueError("VSIX documentation identity mismatch")
        icon = archive.read("extension/media/icon.png")
        if (len(icon) < 24 or icon[:8] != b"\x89PNG\r\n\x1a\n"
                or struct.unpack(">II", icon[16:24]) != (256, 256)):
            raise ValueError("VSIX icon mismatch")
        return {**expected, "engines": manifest["engines"], "files": sorted(names)}


if __name__ == "__main__":
    try:
        print(json.dumps(inspect(sys.argv[1], sys.argv[2]), sort_keys=True))
    except Exception:
        print("VSIX structured inspection failed", file=sys.stderr)
        sys.exit(1)
