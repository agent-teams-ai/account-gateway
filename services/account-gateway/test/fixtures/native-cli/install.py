#!/usr/bin/env python3
"""Fetch exact public CLI assets to fresh task scratch, without package scripts.

Run this networked preparation step before the isolated qualification. The
checked-in SHA512/archive/binary pins are the authority; npm's exact-version
metadata must independently agree. No global or project dependency is changed.
"""
import argparse
import base64
import hashlib
import json
import pathlib
import tarfile
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", required=True)
    options = parser.parse_args()
    destination = pathlib.Path(options.destination)
    if not destination.is_absolute() or destination.exists():
        raise RuntimeError("installer requires a fresh absolute task directory")
    source = pathlib.Path(__file__).with_name("pins.json").read_bytes()
    pins = json.loads(source)
    destination.mkdir(mode=0o700, parents=True)
    installed = []
    for client in pins["clients"]:
        with urllib.request.urlopen("https://registry.npmjs.org/" + client["package"] + "/" + client["version"], timeout=30) as response:
            metadata = json.load(response)
        if metadata["dist"]["integrity"] != client["integrity"] or metadata["dist"]["tarball"] != client["tarball"]:
            raise RuntimeError("exact-version registry metadata differs from source pins")
        target = destination / client["id"]
        target.mkdir(mode=0o700)
        archive = target / "package.tgz"
        sha256, sha512, size = hashlib.sha256(), hashlib.sha512(), 0
        with urllib.request.urlopen(client["tarball"], timeout=120) as response, archive.open("xb") as output:
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > 200 * 1024 * 1024:
                    raise RuntimeError("client archive exceeds qualified bound")
                sha256.update(chunk)
                sha512.update(chunk)
                output.write(chunk)
        if sha256.hexdigest() != client["archiveSHA256"] or "sha512-" + base64.b64encode(sha512.digest()).decode() != client["integrity"]:
            raise RuntimeError("client archive integrity mismatch")
        with tarfile.open(archive) as contents:
            members = contents.getmembers()
            if len(members) > 4096 or sum(member.size for member in members) > 2 * 1024**3:
                raise RuntimeError("client unpacked content exceeds qualified bound")
            for member in members:
                path = pathlib.PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts or path.parts[0] != "package" or not (member.isfile() or member.isdir()):
                    raise RuntimeError("unsafe client archive member")
            contents.extractall(target, filter="data")
        binary = target / client["binary"]
        if hashlib.sha256(binary.read_bytes()).hexdigest() != client["binarySHA256"]:
            raise RuntimeError("installed client binary mismatch")
        binary.chmod(0o755)
        installed.append({**client, "executable": str(binary), "archiveBytes": size})
    receipt = {**pins, "pinsSHA256": hashlib.sha256(source).hexdigest(), "clients": installed}
    receipt_path = destination / "clients.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    receipt_path.chmod(0o600)
    print(json.dumps({"outcome": "pass", "receipt": str(receipt_path), "clients": [{"id": c["id"], "version": c["version"], "binarySHA256": c["binarySHA256"]} for c in installed]}))


if __name__ == "__main__":
    main()
