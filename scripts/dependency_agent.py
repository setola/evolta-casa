#!/usr/bin/env python3
"""Trusted dependency integration controller. Python stdlib + git, gh and Docker.

Run this copy from the trusted checkout, never the copy in a dependency PR.
State lives outside the checkout. No scheduler or model is embedded here.
"""
import argparse
import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

REPO = "setola/evolta-casa"
BOT = "dependabot[bot]"
BASE = "develop"
PROD = "main"
SITE = "https://setola.github.io/evolta-casa"
MAX_ATTEMPTS = 3
WORKFLOWS = (".github/workflows/ci.yml", ".github/workflows/pages.yml")
NODE_IMAGE = re.compile(r"node:(\d+\.\d+\.\d+)-bookworm-slim@sha256:[a-f0-9]{64}")


class Stop(RuntimeError):
    pass


class Unsafe(Stop):
    """The environment is not confirmed safe for an automatic retry."""


def run(*args, cwd=None, timeout=120, capture=True):
    result = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=timeout)
    if not capture or result.returncode:
        print(result.stdout, end="", flush=True)
    if result.returncode:
        raise Stop(f"Command failed ({result.returncode}): {args[0]}")
    return result.stdout.strip()


def api(path, *args):
    return json.loads(run("gh", "api", path, *args) or "null")


def git(root, *args):
    return run("git", "-C", str(root), *args)


def atomic_json(path, value):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=2) + "\n")
    tmp.replace(path)


def yaml_lines(text):
    """Conservative block-scalar tracking, not a general-purpose YAML parser.

    Only existing, otherwise identical YAML may pass the policy. Do not treat shell
    text inside run/command/etc. block scalars as YAML image or action references.
    """
    scalar_indent = None
    for line in text.splitlines(keepends=True):
        indent = len(line) - len(line.lstrip(" "))
        if scalar_indent is not None:
            if not line.strip() or indent > scalar_indent:
                yield line, False
                continue
            scalar_indent = None
        if re.search(r":\s*[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*(?:#.*)?$", line.rstrip()):
            scalar_indent = indent
        yield line, True


def normalize_yaml(text, actions=False):
    output = []
    for line, structural in yaml_lines(text):
        if structural:
            if actions:
                line = re.sub(r"^(\s*-\s*uses:\s+[\w./-]+)@[\w.\-]+(\s*(?:#.*)?)$",
                              r"\1@VERSION\2", line)
            match = re.fullmatch(r"(\s*image:\s*)([\w./:@\-]+)(\s*(?:#.*)?)", line)
            if match:
                reference = match.group(2).split("@", 1)[0]
                repository, separator, tag = reference.rpartition(":")
                if separator and tag and "/" not in tag:
                    # Preserve the registry/repository: only its tag/digest may change.
                    line = f"{match.group(1)}{repository}:VERSION{match.group(3)}"
        output.append(line)
    return "".join(output)


def normalize_workflow(text):
    return normalize_yaml(text, actions=True)


def normalize_compose(text):
    return normalize_yaml(text)


def policy_error(path, old, new):
    """Fail closed: candidate changes cannot rewrite the automation or its gates."""
    if new is None or old is None:
        return f"File addition/deletion needs review: {path}"
    if path in WORKFLOWS:
        if normalize_workflow(old) != normalize_workflow(new):
            return f"Workflow structure/permissions changed: {path}"
        return None
    if path == "compose.yaml":
        if normalize_compose(old) != normalize_compose(new):
            return "Compose may change image references only"
        return None
    if path == "package.json":
        a, b = json.loads(old), json.loads(new)
        version = re.compile(r"[~^=]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")
        for key in ("dependencies", "devDependencies"):
            before, after = a.pop(key, {}), b.pop(key, {})
            if before.keys() != after.keys():
                return "Dependency additions/removals require human review"
            if any(not isinstance(v, str) or not version.fullmatch(v) for v in after.values()):
                return "Only semver dependency versions are automatic; no aliases/local/Git references"
        for value in (a, b):
            engines = value.get("engines", {}).copy()
            engines.pop("node", None)
            value["engines"] = engines
        return None if a == b else "package.json scripts/metadata changed"
    if path in ("package-lock.json", "README.md"):
        return None
    if path.startswith("src/") and not re.search(r"(^|/)(__tests__|__snapshots__)(/|$)|\.(test|spec)\.", path):
        return None
    return f"Protected or unsupported path: {path}"


def validate_lock(manifest, lock):
    """Public npm packages only: a semver manifest cannot hide a tarball alias."""
    if lock.get("lockfileVersion") != 3 or "" not in lock.get("packages", {}):
        raise Stop("Expected npm lockfile v3 with root package metadata")
    root = lock["packages"][""]
    for key in ("dependencies", "devDependencies", "engines"):
        if root.get(key, {}) != manifest.get(key, {}):
            raise Stop(f"Lockfile root {key} differs from package.json")
    for path, info in lock["packages"].items():
        if not path:
            continue
        name = path.rsplit("node_modules/", 1)[-1]
        if (not path.startswith("node_modules/") or info.get("link")
                or not re.fullmatch(r"(?:@[a-z0-9_.-]+/)?[a-z0-9_.-]+", name)
                or info.get("name", name) != name):
            raise Stop(f"Unsupported package identity in lockfile: {path}")
        version = info.get("version", "")
        if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
            raise Stop(f"Unsupported locked version: {path}")
        expected = f"https://registry.npmjs.org/{name}/-/{name.rsplit('/', 1)[-1]}-{version}.tgz"
        if info.get("resolved") != expected:
            raise Stop(f"Lockfile tarball must match registry/package/version: {path}")
        integrity = info.get("integrity", "")
        try:
            digest = base64.b64decode(integrity.removeprefix("sha512-"), validate=True)
        except ValueError:
            digest = b""
        if not integrity.startswith("sha512-") or len(digest) != 64:
            raise Stop(f"Expected SHA-512 npm integrity: {path}")


def aligned_image(files):
    images = []
    for path in ("compose.yaml", *WORKFLOWS):
        full = []
        for line, structural in yaml_lines(files[path]):
            image = re.fullmatch(r"\s*image:\s*(\S+)\s*(?:#.*)?", line)
            if structural and image and NODE_IMAGE.fullmatch(image.group(1)):
                full.append(image.group(1))
        if len(full) != 1:
            raise Stop(f"Expected one pinned official Node image in {path}")
        images.extend(full)
    if len(set(images)) != 1:
        raise Stop("Node image/digest must match in Compose and both workflows")
    match = NODE_IMAGE.fullmatch(images[0])
    if match is None:
        raise Stop("Invalid pinned Node image")
    version = match.group(1)
    if json.loads(files["package.json"]).get("engines", {}).get("node") != f"^{version}":
        raise Stop(f"Align package.json engines.node to ^{version}")
    return images[0]


class Controller:
    def __init__(self, root):
        self.root = root
        common = Path(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"))
        identity = hashlib.sha256(str(common).encode()).hexdigest()[:12]
        home = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
        self.home = home / "evolta-casa-dependency-agent" / identity
        self.home.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_path = self.home / "state.json"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {"active": None, "history": [], "halt": None}

    @contextlib.contextmanager
    def lock(self):
        with (self.home / "lock").open("w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Stop("Another controller command is running")
            # Read under the lock: a process may have finished after our constructor.
            if self.state_path.exists():
                self.state = json.loads(self.state_path.read_text())
            yield

    def save(self):
        atomic_json(self.state_path, self.state)

    def fetch(self):
        if git(self.root, "remote", "get-url", "origin") not in (
                f"git@github.com:{REPO}.git", f"https://github.com/{REPO}.git"):
            raise Stop("Unexpected origin; refusing to publish")
        git(self.root, "fetch", "origin", BASE, PROD)

    def ref(self, name):
        return git(self.root, "rev-parse", f"origin/{name}")

    def pr(self, number):
        pr = api(f"repos/{REPO}/pulls/{number}")
        if (pr["user"]["login"] != BOT or pr["user"]["type"] != "Bot"
                or pr["head"]["repo"] is None or pr["head"]["repo"]["full_name"] != REPO
                or pr["base"]["ref"] != BASE or pr["draft"]):
            raise Stop("Not an eligible same-repository Dependabot PR to develop")
        return pr

    def candidates(self):
        pages = api(f"repos/{REPO}/pulls?state=open&base={BASE}&per_page=100", "--paginate", "--slurp")
        return sorted((p for page in pages for p in page
                       if p["user"]["login"] == BOT and p["user"]["type"] == "Bot"
                       and not p["draft"] and p["head"]["repo"] is not None
                       and p["head"]["repo"]["full_name"] == REPO
                       and p["base"]["ref"] == BASE), key=lambda p: p["number"])

    def active(self, token):
        a = self.state["active"]
        if not a or not secrets.compare_digest(a["token"], token):
            raise Stop("No matching active operation")
        return a

    def comment(self, a, text):
        # Comments are a report, never a command source. Failure cannot undo a merge.
        try:
            run("gh", "pr", "comment", str(a["number"]), "--repo", REPO, "--body", text)
        except (Stop, subprocess.TimeoutExpired) as error:
            print(f"Warning: comment not posted: {error}")

    def check_policy(self, a):
        work = Path(a["worktree"])
        # Includes tracked modifications and newly created files, not ignored build output.
        changes = set(git(work, "diff", "--name-only", a["base"]).splitlines())
        changes.update(git(work, "ls-files", "--others", "--exclude-standard").splitlines())
        for path in changes:
            mode = git(work, "ls-tree", a["base"], "--", path).split()
            target = work / path
            if not mode or mode[0] != "100644" or target.is_symlink() or not target.is_file():
                raise Stop(f"New/deleted/symlink/nonregular file needs review: {path}")
            old = git(work, "show", f"{a['base']}:{path}")
            new = target.read_text().strip()
            error = policy_error(path, old, new)
            if error:
                raise Stop(error)
            # Do not allow executable bits/submodules to be introduced.
            if target.stat().st_mode & 0o111:
                raise Stop(f"Executable candidate file needs review: {path}")
        files = {p: (work / p).read_text() for p in ("compose.yaml", *WORKFLOWS, "package.json", "package-lock.json")}
        validate_lock(json.loads(files["package.json"]), json.loads(files["package-lock.json"]))
        return aligned_image(files)

    def fingerprint(self, directory):
        # No host Git operation ever reads metadata writable by the build container.
        digest = hashlib.sha256()
        for parent, dirs, files in os.walk(directory, followlinks=False):
            if Path(parent) == directory:
                dirs[:] = [d for d in dirs if d not in ("node_modules", "dist")]
            for name in sorted(files):
                target = Path(parent) / name
                digest.update(str(target.relative_to(directory)).encode())
                if target.is_symlink():
                    digest.update(os.readlink(target).encode())
                else:
                    digest.update(target.read_bytes())
                    digest.update(str(target.stat().st_mode).encode())
        return digest.hexdigest()

    def verify(self, a):
        # These tests belong to the trusted controller, never execute candidate Python.
        run(sys.executable, "-B", "-m", "unittest", "discover", "-s",
            str(self.root / "scripts/tests"), "-p", "test_*.py", capture=False)
        image = self.check_policy(a)
        work = Path(a["worktree"])
        sha = a["verifying_sha"]
        if git(work, "rev-parse", "HEAD") != sha or git(work, "status", "--porcelain"):
            raise Stop("Verification requires a clean checkout of the exact candidate SHA")
        sandbox = Path(tempfile.mkdtemp(prefix="source-", dir=self.home))
        source = sandbox / "app"
        archive = sandbox / "source.tar"
        git(self.root, "archive", "--format=tar", f"--output={archive}", sha)
        with tarfile.open(archive) as contents:
            contents.extractall(source, filter="data")
        archive.unlink()
        # Build sees only a fresh source export, never Git metadata or ignored host files.
        for name in ("node_modules", "dist"):
            (source / name).mkdir(exist_ok=True)
        before = self.fingerprint(source)
        container = f"dependency-agent-{a['token']}-{a['attempts']}"
        command = ["docker", "run", "--rm", "--name", container, "--init", "--user", f"{os.getuid()}:{os.getgid()}",
                   "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=2g", "--cpus=2",
                   "--pids-limit=256", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
                   "--mount", f"type=bind,src={source},dst=/app,readonly",
                   "--mount", f"type=bind,src={source / 'node_modules'},dst=/app/node_modules",
                   "--mount", f"type=bind,src={source / 'dist'},dst=/app/dist",
                   "--workdir", "/app", "--env", "HOME=/tmp", "--env", "NPM_CONFIG_CACHE=/tmp/npm-cache",
                   "--env", "BASE_PATH=/evolta-casa/", "--env", f"SITE_URL={SITE}", image,
                   "sh", "-ec", "npm ci && npm test && npm run build"]
        log = self.home / f"{a['token']}-attempt-{a['attempts']}-{sha[:12]}.log"
        print(f"Verification log: {log}", flush=True)
        try:
            try:
                with log.open("w") as output:
                    result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT, timeout=900)
            finally:
                # A timeout kills the Docker client, not necessarily its container.
                try:
                    subprocess.run(["docker", "rm", "-f", container], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, timeout=30)
                    remaining = run("docker", "container", "ls", "--all", "--filter",
                                    f"name=^/{container}$", "--format", "{{.ID}}", timeout=30)
                    if remaining:
                        raise Stop("Container still present")
                except Exception as error:
                    raise Unsafe(f"Cannot confirm container stopped; retain {sandbox}: {error}") from error
            print(log.read_text(), flush=True)
            if result.returncode:
                raise Stop(f"Install/test/build failed; see {log}")
            if self.fingerprint(source) != before:
                raise Stop("Verification modified source files; inspect and rerun")
            if git(work, "rev-parse", "HEAD") != sha or git(work, "status", "--porcelain"):
                raise Stop("Worktree changed during verification")
        except Unsafe:
            raise  # Keep the export if Docker's state is uncertain.
        except BaseException:
            shutil.rmtree(sandbox)
            raise
        else:
            shutil.rmtree(sandbox)
        return image

    def start(self, number=None):
        if self.state["halt"]:
            raise Stop(f"Automation halted: {self.state['halt']}")
        if self.state["active"]:
            print(json.dumps({"status": "busy", "active": self.state["active"]}, indent=2))
            return
        self.fetch()
        trusted = "scripts/dependency_agent.py"
        if (self.root / trusted).read_text().strip() != git(self.root, "show", f"origin/{BASE}:{trusted}"):
            raise Stop("Local controller differs from trusted develop; review/sync it first")
        if self.ref(BASE) != self.ref(PROD):
            raise Stop("develop and main differ: refusing to release unrelated changes")
        seen = {(h["number"], h["head"]) for h in self.state["history"]}
        choices = self.candidates() if number is None else [self.pr(number)]
        choices = [p for p in choices if (p["number"], p["head"]["sha"]) not in seen]
        if not choices:
            print('{"status": "idle", "message": "No new eligible PR revisions"}')
            return
        pr = self.pr(choices[0]["number"])
        if pr["state"] != "open":
            raise Stop("PR is no longer open")
        token = secrets.token_hex(12)
        work = self.home / f"work-{token}"
        a = {"token": token, "number": pr["number"], "head": pr["head"]["sha"],
             "branch": pr["head"]["ref"], "base": self.ref(BASE), "worktree": str(work),
             "attempts": 0, "stage": "preparing", "created": time.time()}
        self.state["active"] = a
        self.save()
        try:
            git(self.root, "fetch", "origin", f"refs/pull/{a['number']}/head")
            if git(self.root, "rev-parse", "FETCH_HEAD") != a["head"]:
                raise Stop("PR moved during preparation")
            git(self.root, "worktree", "add", "--detach", str(work), a["base"])
            git(work, "merge", "--no-ff", "--no-edit", a["head"])
            a["integration"] = git(work, "rev-parse", "HEAD")
            a["stage"] = "prepared"
            self.save()
        except Exception as error:
            self.needs_fix(a, error)
            return
        self.finish(token)

    def needs_fix(self, a, error):
        a["stage"] = "needs-fix"
        a["error"] = str(error)
        self.save()
        print(json.dumps(a, indent=2), flush=True)
        if a["attempts"] >= MAX_ATTEMPTS:
            self.abort(a["token"], f"Attempt limit reached: {error}")

    def wait_ci(self, sha, workflow, event, branch):
        # Query by immutable SHA and trusted workflow path, not by a spoofable check name.
        deadline = time.monotonic() + 1200
        while time.monotonic() < deadline:
            query = urllib.parse.urlencode({"head_sha": sha, "event": event, "branch": branch, "per_page": 100})
            data = api(f"repos/{REPO}/actions/workflows/{workflow}/runs?{query}")
            runs = [r for r in data["workflow_runs"] if r["head_sha"] == sha]
            if runs:
                latest = max(runs, key=lambda r: r["id"])
                if latest["status"] == "completed":
                    if latest["conclusion"] != "success":
                        raise Stop(f"{workflow} failed: {latest['html_url']}")
                    return latest["html_url"]
            time.sleep(10)
        raise Stop(f"Timed out waiting for {workflow} on {sha}")

    def finish(self, token):
        a = self.active(token)
        if self.state["halt"] or a["stage"] not in ("prepared", "needs-fix"):
            raise Stop("Cannot resume this stage; inspect status before any recovery")
        if a["attempts"] >= MAX_ATTEMPTS:
            raise Stop("Attempt limit reached")
        a["attempts"] += 1
        a["stage"] = "verifying"
        self.save()
        try:
            self.fetch()
            pr = self.pr(a["number"])
            if pr["state"] != "open" or pr["head"]["sha"] != a["head"] or pr["head"]["ref"] != a["branch"]:
                raise Stop("PR changed: abort this operation and prepare the new revision")
            if self.ref(BASE) != a["base"] or self.ref(PROD) != a["base"]:
                raise Stop("Base branches moved: abort and prepare again")
            work = Path(a["worktree"])
            if git(work, "ls-files", "-u"):
                raise Stop("Unresolved merge conflicts")
            # Ensure fixes preserve both tested parents, not a reset to another revision.
            git(work, "merge-base", "--is-ancestor", a["base"], "HEAD")
            git(work, "merge-base", "--is-ancestor", a["head"], "HEAD")
            self.check_policy(a)
            dirty = bool(git(work, "status", "--porcelain", "--untracked-files=normal"))
            if dirty:
                git(work, "add", "-A")
                git(work, "commit", "-m", f"fix: align dependency update for PR #{a['number']}")
            sha = git(work, "rev-parse", "HEAD")
            a["verifying_sha"] = sha
            self.save()
            a["image"] = self.verify(a)
            if dirty or sha != a.get("integration"):
                a["stage"] = "publishing-fix"
                self.save()
                # Normal fast-forward push, never force-push or bypass repository rules.
                git(work, "push", "origin", f"{sha}:refs/heads/{a['branch']}")
                a["head"] = sha
                a["integration"] = sha
                a["stage"] = "verifying"
                self.save()
            a["pr_ci"] = self.wait_ci(a["head"], "ci.yml", "pull_request", a["branch"])
            self.fetch()
            pr = self.pr(a["number"])
            if pr["head"]["sha"] != a["head"] or self.ref(BASE) != a["base"] or self.ref(PROD) != a["base"]:
                raise Stop("Refs changed after verification; refusing merge")
        except Exception as error:
            if a["stage"] == "publishing-fix" or isinstance(error, Unsafe):
                self.halt(a, error)  # Push outcome may be ambiguous: never blindly retry.
            else:
                self.needs_fix(a, error)
            return

        # From this point, failures halt the entire queue. A merge may have succeeded
        # even if the transport reports failure. Recovery must inspect remote reality.
        a["stage"] = "merging"
        self.save()
        try:
            run("gh", "pr", "merge", str(a["number"]), "--repo", REPO, "--merge",
                "--match-head-commit", a["head"], timeout=120)
            merged = self.pr(a["number"])
            if not merged["merged"]:
                raise Stop("GitHub did not merge the PR")
            a["merged"] = merged["merge_commit_sha"]
            self.fetch()
            if self.ref(BASE) != a["merged"] or self.ref(PROD) != a["base"]:
                raise Stop("Branch moved during merge; not promoting unrelated changes")
            parents = git(self.root, "show", "-s", "--format=%P", a["merged"]).split()
            if parents != [a["base"], a["head"]]:
                raise Stop("Unexpected merge parents; manual inspection required")
            git(work, "reset", "--hard", a["merged"])
            a["stage"] = "verifying-merged"
            a["verifying_sha"] = a["merged"]
            self.save()
            self.verify(a)
            a["develop_ci"] = self.wait_ci(a["merged"], "ci.yml", "push", BASE)
            self.fetch()
            if self.ref(BASE) != a["merged"] or self.ref(PROD) != a["base"]:
                raise Stop("Branches changed before promotion")
            a["stage"] = "releasing"
            self.save()
            git(work, "push", "origin", f"{a['merged']}:refs/heads/{PROD}")
            a["deploy"] = self.wait_ci(a["merged"], "pages.yml", "push", PROD)
            self.fetch()
            if self.ref(PROD) != a["merged"]:
                raise Stop("Production branch moved during deploy")
            for route in ("/", "/consumi/", "/prezzi/", "/tetto/"):
                with urllib.request.urlopen(SITE + route, timeout=30) as response:
                    if response.status != 200 or b"<html" not in response.read().lower():
                        raise Stop(f"HTTP smoke test failed: {route}")
            a["stage"] = "released"
            self.comment(a, f"Pi dependency agent: merged and released `{a['merged']}`.\n\n"
                         f"Local npm ci, tests, build and runtime alignment passed.\n"
                         f"PR CI: {a['pr_ci']}\nIntegration CI: {a['develop_ci']}\n"
                         f"Production deploy: {a['deploy']}\nHTTP smoke checks passed (home, consumi, prezzi, tetto).")
            self.complete(a)
        except Exception as error:
            self.halt(a, error)

    def halt(self, a, error):
        a["error"] = str(error)
        self.state["halt"] = f"PR #{a['number']}, stage {a['stage']}: {error}"
        self.save()
        self.comment(a, f"Pi dependency agent STOPPED: {self.state['halt']}\nNo further PRs will be processed until human recovery.")
        print(json.dumps(self.state, indent=2))

    def complete(self, a):
        self.state["history"].append(dict(a))
        self.state["active"] = None
        self.save()  # Durable success before best-effort cleanup.
        print(json.dumps(a, indent=2))
        try:
            git(self.root, "worktree", "remove", "--force", a["worktree"])
        except Stop:
            print("Warning: worktree retained; operation outcome is already recorded")

    def abort(self, token, reason):
        a = self.active(token)
        if self.state["halt"] or a["stage"] not in ("preparing", "prepared", "needs-fix"):
            raise Stop("Potential remote effects: human recovery required; do not auto-abort")
        a["stage"] = "blocked"
        a["error"] = reason
        self.comment(a, f"Pi dependency agent requires review: {reason}\nRevision `{a['head']}` will not be retried automatically.")
        self.complete(a)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("start", "finish", "abort", "status"))
    parser.add_argument("token", nargs="?")
    parser.add_argument("--pr", type=int)
    parser.add_argument("--reason", default="Needs human review")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    controller = Controller(root)
    with controller.lock():
        if args.command == "status":
            print(json.dumps(controller.state, indent=2))
        elif args.command == "start":
            controller.start(args.pr)
        elif not args.token:
            parser.error("finish/abort require the operation token printed by start")
        elif args.command == "finish":
            controller.finish(args.token)
        else:
            controller.abort(args.token, args.reason)
    if controller.state["halt"]:
        return 2
    active = controller.state["active"]
    return 1 if active and active["stage"] == "needs-fix" else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Stop, subprocess.TimeoutExpired) as error:
        print(f"STOP: {error}", file=sys.stderr)
        sys.exit(2)
