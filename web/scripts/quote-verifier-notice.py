"""Writes the third-party notice for the quote verifier: every crate it links, with its licence.

Run by scripts/build-quote-verifier.sh after a build, from the web directory.
"""
import json
import subprocess

meta = json.loads(subprocess.run(["cargo", "metadata", "--format-version", "1", "--manifest-path", "quote-verifier/Cargo.toml"], capture_output=True, text=True, check=True).stdout)
nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
packages = {p["id"]: p for p in meta["packages"]}
root = meta["resolve"]["root"]

# Only what the verifier links: normal dependencies reachable from it, not build or dev ones.
linked, stack = set(), [root]
while stack:
    current = stack.pop()
    if current in linked:
        continue
    linked.add(current)
    stack += [d["pkg"] for d in nodes[current]["deps"] if any(k.get("kind") is None for k in d["dep_kinds"])]
linked.discard(root)

rows = sorted((packages[i]["name"], packages[i]["version"], packages[i].get("license") or "see the crate", packages[i].get("repository") or "") for i in linked)
lines = [
    "# Third-party code in the quote verifier",
    "",
    "`quote_verifier_bg.wasm` is compiled from [`web/quote-verifier`](../../../quote-verifier) and links the crates below, each under its own licence. Their source and licence texts are on crates.io and in each repository. `scripts/build-quote-verifier.sh` regenerates this list.",
    "",
    "| Crate | Version | Licence | Source |",
    "|---|---|---|---|",
] + [f"| {name} | {version} | {licence} | {source} |" for name, version, licence, source in rows]
with open("src/vendor/quote-verifier/THIRD-PARTY.md", "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
print(f"{len(rows)} linked crates listed in src/vendor/quote-verifier/THIRD-PARTY.md")
