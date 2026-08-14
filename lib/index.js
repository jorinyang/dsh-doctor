import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";
//#region src/diagnose.ts
/**
* dsh-doctor diagnosis engine: read-only checks returning a structured report.
* All checks are read-only; the tool returns fix hints rather than mutating state.
*
* @module @jorinyang/dsh-doctor/diagnose
*/
const execFileAsync$1 = promisify(execFile);
const execAsync$1 = promisify(exec);
function resolveDshHome$2() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
async function runVersion(cmd, args) {
	try {
		const { stdout } = await execAsync$1(cmd + " " + args.join(" "), { timeout: 1e4 });
		return stdout.trim();
	} catch {
		return null;
	}
}
function checkPort(port) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", (err) => {
			if (err.code === "EADDRINUSE") resolve({
				free: false,
				error: "port " + port + " is in use"
			});
			else resolve({ free: true });
		});
		server.once("listening", () => {
			server.close(() => resolve({ free: true }));
		});
		server.listen(port, "127.0.0.1");
	});
}
function checkHealth$1(port) {
	return new Promise((resolve) => {
		const req = http.get({
			host: "127.0.0.1",
			port,
			path: "/",
			timeout: 5e3
		}, (res) => {
			resolve({
				ok: res.statusCode === 200,
				status: res.statusCode
			});
			res.resume();
		});
		req.on("timeout", () => {
			req.destroy();
			resolve({ ok: false });
		});
		req.on("error", () => resolve({ ok: false }));
	});
}
function readPackageJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}
async function runDiagnostic(profile, port) {
	const dshHome = resolveDshHome$2();
	const profileDir = join(dshHome, "profiles", profile);
	const checks = [];
	const nodeVersion = await runVersion("node", ["--version"]);
	const pnpmVersion = await runVersion("pnpm", ["--version"]);
	const dshVersion = await runVersion("dsh", ["--version"]);
	if (nodeVersion) checks.push({
		kind: "env",
		status: "ok",
		detail: "Node.js " + nodeVersion
	});
	else checks.push({
		kind: "env",
		status: "fail",
		detail: "Node.js not found in PATH",
		fixHint: "Install Node.js >= 20"
	});
	if (pnpmVersion) checks.push({
		kind: "env",
		status: "ok",
		detail: "pnpm " + pnpmVersion
	});
	else checks.push({
		kind: "env",
		status: "fail",
		detail: "pnpm not found in PATH",
		fixHint: "npm install -g pnpm"
	});
	if (dshVersion) checks.push({
		kind: "env",
		status: "ok",
		detail: "DSH " + dshVersion
	});
	else checks.push({
		kind: "env",
		status: "fail",
		detail: "dsh command unavailable",
		fixHint: "npm install -g @deepseek-ai/dsh"
	});
	if (existsSync(dshHome)) {
		checks.push({
			kind: "home",
			status: "ok",
			detail: "DSH home exists: " + dshHome
		});
		for (const dir of [
			"profiles",
			"sessions",
			"storages",
			"skills",
			"scripts",
			"cache"
		]) {
			const p = join(dshHome, dir);
			if (existsSync(p)) checks.push({
				kind: "home",
				status: "ok",
				detail: "dir exists: " + dir
			});
			else checks.push({
				kind: "home",
				status: "warn",
				detail: "dir missing: " + dir + " (auto-created on first launch)"
			});
		}
	} else checks.push({
		kind: "home",
		status: "fail",
		detail: "DSH home missing: " + dshHome,
		fixHint: "First dsh run auto-creates it"
	});
	if (existsSync(profileDir)) {
		checks.push({
			kind: "profile",
			status: "ok",
			detail: "profile dir exists: " + profile
		});
		for (const f of [
			"package.json",
			"pnpm-workspace.yaml",
			"pnpm-lock.yaml",
			"cordis.yml",
			"cordis.patch.yml"
		]) {
			const p = join(profileDir, f);
			if (existsSync(p)) checks.push({
				kind: "profile",
				status: "ok",
				detail: "file exists: " + f
			});
			else checks.push({
				kind: "profile",
				status: "fail",
				detail: "file missing: " + f,
				fixHint: "Re-run dsh --profile " + profile + " to re-init"
			});
		}
		if (existsSync(join(profileDir, "node_modules"))) checks.push({
			kind: "profile",
			status: "ok",
			detail: "node_modules exists"
		});
		else checks.push({
			kind: "profile",
			status: "warn",
			detail: "node_modules missing",
			fixHint: "Run pnpm install in profile dir"
		});
	} else checks.push({
		kind: "profile",
		status: "fail",
		detail: "profile dir missing: " + profileDir,
		fixHint: "Run dsh --profile " + profile + " to init"
	});
	const pkgPath = join(profileDir, "package.json");
	const pkg = readPackageJson(pkgPath);
	if (pkg === null) {
		if (existsSync(pkgPath)) checks.push({
			kind: "config",
			status: "fail",
			detail: "package.json JSON parse error",
			fixHint: "Backup and rebuild package.json"
		});
	} else checks.push({
		kind: "config",
		status: "ok",
		detail: "package.json JSON valid"
	});
	const wsPath = join(profileDir, "pnpm-workspace.yaml");
	if (existsSync(wsPath)) {
		if (readFileSync(wsPath, "utf8").includes("set this to true or false")) checks.push({
			kind: "config",
			status: "fail",
			detail: "pnpm-workspace.yaml has allowBuilds placeholder",
			fixHint: "Replace placeholder with true/false"
		});
		else checks.push({
			kind: "config",
			status: "ok",
			detail: "pnpm-workspace.yaml no allowBuilds placeholder"
		});
	}
	if (pkg?.dsh?.profile?.bundles) {
		const bundles = pkg.dsh.profile.bundles;
		checks.push({
			kind: "deps",
			status: "warn",
			detail: "declared bundles: " + bundles.join(", ")
		});
		const nm = join(profileDir, "node_modules");
		const coreBundles = /* @__PURE__ */ new Set(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);
		for (const b of bundles) {
			if (coreBundles.has(b)) {
				checks.push({
					kind: "deps",
					status: "ok",
					detail: "core bundle (provided by global dsh): " + b
				});
				continue;
			}
			if (existsSync(join(nm, b))) checks.push({
				kind: "deps",
				status: "ok",
				detail: "bundle installed: " + b
			});
			else checks.push({
				kind: "deps",
				status: "fail",
				detail: "bundle missing: " + b,
				fixHint: "Run pnpm install in profile dir"
			});
		}
		const deps = pkg.dependencies;
		if (deps) {
			for (const [depName, depSpec] of Object.entries(deps)) if (depSpec.startsWith("link:")) {
				const target = depSpec.slice(5);
				const resolved = target.startsWith(".") ? join(profileDir, target) : target;
				if (existsSync(resolved)) checks.push({
					kind: "deps",
					status: "ok",
					detail: "link dependency valid: " + depName
				});
				else checks.push({
					kind: "deps",
					status: "fail",
					detail: "link dependency broken: " + depName + " -> " + resolved,
					fixHint: "Re-link or remove the dependency"
				});
			}
		}
	}
	try {
		const { stdout } = await execAsync$1("dsh --profile " + profile + " --dump-config", { timeout: 3e4 });
		checks.push({
			kind: "mount",
			status: "ok",
			detail: "--dump-config succeeded"
		});
		for (const core of ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]) if (stdout.includes(core)) checks.push({
			kind: "mount",
			status: "ok",
			detail: "core bundle mounted: " + core
		});
		else checks.push({
			kind: "mount",
			status: "fail",
			detail: "core bundle not mounted: " + core,
			fixHint: "Check package.json dsh.profile.bundles"
		});
	} catch (err) {
		checks.push({
			kind: "mount",
			status: "fail",
			detail: "--dump-config failed: " + (err?.message ?? String(err)),
			fixHint: "Check cordis.patch.yml and bundle config"
		});
	}
	const portResult = await checkPort(port);
	if (portResult.free) checks.push({
		kind: "port",
		status: "ok",
		detail: "port " + port + " is free"
	});
	else checks.push({
		kind: "port",
		status: "warn",
		detail: portResult.error ?? "port " + port + " in use",
		fixHint: "Stop the occupying process or use --port"
	});
	const health = await checkHealth$1(port);
	if (health.ok) checks.push({
		kind: "health",
		status: "ok",
		detail: "HTTP " + health.status + " - DSH web running"
	});
	else checks.push({
		kind: "health",
		status: "warn",
		detail: "no HTTP 200 on port " + port,
		fixHint: "Start DSH: dsh web"
	});
	try {
		const { execFileSync } = await import("node:child_process");
		if (process.platform === "win32") {
			const drive = dshHome.slice(0, 2);
			const out = execFileSync("wmic", [
				"logicaldisk",
				"where",
				"DeviceID='" + drive + "'",
				"get",
				"FreeSpace,Size",
				"/value"
			], { timeout: 1e4 }).toString();
			const freeGB = Number(out.match(/FreeSpace=(\d+)/)?.[1] ?? "0") / 1024 ** 3;
			checks.push({
				kind: "disk",
				status: freeGB < 1 ? "fail" : "ok",
				detail: "disk " + drive + " free: " + freeGB.toFixed(2) + " GB",
				fixHint: freeGB < 1 ? "Clean disk or migrate DSH_HOME" : void 0
			});
		} else {
			const { stdout } = await execFileAsync$1("df", ["-h", dshHome], { timeout: 1e4 });
			checks.push({
				kind: "disk",
				status: "ok",
				detail: "disk: " + stdout.trim().split("\n").pop()
			});
		}
	} catch {
		checks.push({
			kind: "disk",
			status: "warn",
			detail: "disk space check skipped"
		});
	}
	const passCount = checks.filter((c) => c.status === "ok").length;
	const failCount = checks.filter((c) => c.status === "fail").length;
	return {
		profile,
		port,
		dshHome,
		checks,
		passCount,
		failCount,
		warnCount: checks.filter((c) => c.status === "warn").length,
		summary: failCount === 0 ? "No blocking issues found; DSH should start normally." : failCount + " blocking issue(s) found; review fix hints."
	};
}
//#endregion
//#region src/journal.ts
/**
* dsh-doctor journal: reversible-effect log with persistent rollback.
*
* Implements the "time composability" half of the Spatiotemporal
* Composability paradigm: every mutation records a serializable undo
* operation; rollback replays them in reverse (LIFO) to restore the
* environment to its pre-repair state.
*
* Undo operations are DATA (not closures) so they survive process exit
* and can be replayed by the standalone CLI, by the agent tools, or by
* the runtime service.
*
* @module @jorinyang/dsh-doctor/journal
*/
function resolveDshHome$1() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
/** Journal storage root: $DSH_HOME/dsh-doctor/journal */
function journalRoot() {
	return join(resolveDshHome$1(), "dsh-doctor", "journal");
}
function timestamp() {
	return (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
}
/**
* Collects reversible effects during a repair run.
* Each mutate records its undo op; backups are stored inside this
* journal's directory so rollback stays self-contained.
*/
var JournalCollector = class {
	id;
	createdAt;
	profile;
	scope;
	entries = [];
	backupCounter = 0;
	dir = null;
	constructor(profile, scope) {
		this.id = "doctor-" + timestamp();
		this.createdAt = (/* @__PURE__ */ new Date()).toISOString();
		this.profile = profile;
		this.scope = scope;
	}
	ensureDir() {
		if (this.dir === null) {
			this.dir = join(journalRoot(), this.id);
			mkdirSync(join(this.dir, "backups"), { recursive: true });
		}
		return this.dir;
	}
	/** Record a reversible file overwrite (save original, write new). */
	overwriteFile(path, newContent, kind, detail) {
		const dir = this.ensureDir();
		const backupPath = join(dir, "backups", "backup-" + this.backupCounter++);
		copyFileSync(path, backupPath);
		writeFileSync(path, newContent);
		this.entries.push({
			kind,
			detail,
			undo: {
				type: "restore-file",
				detail: "restore " + path,
				path,
				backupPath
			}
		});
	}
	/** Record creating a new file (undo = delete it). */
	createFile(path, content, kind, detail) {
		writeFileSync(path, content);
		this.entries.push({
			kind,
			detail,
			undo: {
				type: "delete-file",
				detail: "delete " + path,
				path
			}
		});
	}
	/** Record creating a directory (undo = remove it, best-effort if empty). */
	createDir(path, kind, detail) {
		mkdirSync(path, { recursive: true });
		this.entries.push({
			kind,
			detail,
			undo: {
				type: "remove-dir",
				detail: "remove " + path + " (if empty)",
				path
			}
		});
	}
	/** Record a non-reversible operation (system boundary: needs manual compensation). */
	manual(kind, detail) {
		this.entries.push({
			kind,
			detail,
			undo: {
				type: "manual",
				detail
			}
		});
	}
	/** Persist this journal to disk; returns the journal file path. */
	persist() {
		if (this.entries.length === 0) return null;
		const dir = this.ensureDir();
		const journal = {
			id: this.id,
			createdAt: this.createdAt,
			profile: this.profile,
			scope: this.scope,
			entries: this.entries
		};
		const file = join(dir, "journal.json");
		const tmp = file + ".tmp";
		writeFileSync(tmp, JSON.stringify(journal, null, 2));
		renameSync(tmp, file);
		return file;
	}
};
/** List all persisted journals, newest first. */
function listJournals() {
	const root = journalRoot();
	if (!existsSync(root)) return [];
	const out = [];
	for (const entry of readdirSync(root)) {
		const file = join(root, entry, "journal.json");
		if (existsSync(file)) try {
			out.push(JSON.parse(readFileSync(file, "utf8")));
		} catch {}
	}
	out.sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
	return out;
}
/** Load one journal by id (or full path). */
function loadJournal(id) {
	const file = id.endsWith("journal.json") ? id : join(journalRoot(), id, "journal.json");
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}
/** Execute one undo operation. */
function applyUndo(op) {
	switch (op.type) {
		case "restore-file":
			if (existsSync(op.backupPath)) {
				copyFileSync(op.backupPath, op.path);
				return "undone";
			}
			return "manual";
		case "delete-file":
			if (existsSync(op.path)) rmSync(op.path, { force: true });
			return "undone";
		case "remove-dir":
			if (!existsSync(op.path)) return "undone";
			try {
				if (readdirSync(op.path).length === 0) {
					rmdirSync(op.path);
					return "undone";
				}
				return "manual";
			} catch {
				return "manual";
			}
		case "manual": return "manual";
	}
}
/**
* Roll back one journal: replay undo ops in reverse (LIFO).
* Files that no longer have their backup are reported as manual.
*/
function rollbackJournal(id) {
	const journal = loadJournal(id);
	if (journal === null) return null;
	const steps = [];
	let undoneCount = 0;
	let failedCount = 0;
	let manualCount = 0;
	for (let i = journal.entries.length - 1; i >= 0; i--) {
		const entry = journal.entries[i];
		try {
			if (applyUndo(entry.undo) === "undone") {
				steps.push({
					kind: entry.kind,
					detail: entry.detail,
					status: "undone"
				});
				undoneCount++;
			} else {
				steps.push({
					kind: entry.kind,
					detail: entry.detail,
					status: "manual"
				});
				manualCount++;
			}
		} catch {
			steps.push({
				kind: entry.kind,
				detail: entry.detail,
				status: "failed"
			});
			failedCount++;
		}
	}
	const dir = join(journalRoot(), journal.id);
	if (manualCount === 0 && failedCount === 0 && existsSync(dir)) try {
		rmSync(dir, {
			recursive: true,
			force: true
		});
	} catch {}
	const summary = failedCount === 0 ? "Rollback complete" + (manualCount > 0 ? " (" + manualCount + " step(s) need manual compensation)" : "") + "." : failedCount + " rollback step(s) failed; review the log.";
	return {
		journalId: journal.id,
		undoneCount,
		failedCount,
		manualCount,
		steps,
		summary
	};
}
//#endregion
//#region src/repair.ts
/**
* dsh-doctor repair engine: applies safe, dependency, and process repairs.
* Every mutating action is idempotent and records a reversible effect into
* a journal, so the whole run can be rolled back (LIFO) afterwards.
*
* @module @jorinyang/dsh-doctor/repair
*/
const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
function resolveDshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
/** Run the repair. All actions are idempotent; reversible ones are journaled. */
async function runRepair(profile, port, scope) {
	const dshHome = resolveDshHome();
	const profileDir = join(dshHome, "profiles", profile);
	const actions = [];
	const journal = new JournalCollector(profile, scope);
	if (!existsSync(dshHome)) try {
		journal.createDir(dshHome, "home", "created DSH home: " + dshHome);
		actions.push({
			kind: "home",
			status: "applied",
			detail: "created DSH home: " + dshHome
		});
	} catch (e) {
		actions.push({
			kind: "home",
			status: "failed",
			detail: "failed to create DSH home: " + dshHome,
			hint: e?.message
		});
	}
	else actions.push({
		kind: "home",
		status: "info",
		detail: "DSH home already exists"
	});
	for (const dir of [
		"profiles",
		"sessions",
		"storages",
		"skills",
		"scripts",
		"cache"
	]) {
		const p = join(dshHome, dir);
		if (!existsSync(p)) try {
			journal.createDir(p, "home", "created dir: " + dir);
			actions.push({
				kind: "home",
				status: "applied",
				detail: "created dir: " + dir
			});
		} catch (e) {
			actions.push({
				kind: "home",
				status: "failed",
				detail: "failed to create dir: " + dir,
				hint: e?.message
			});
		}
	}
	if (!existsSync(profileDir)) {
		actions.push({
			kind: "profile",
			status: "info",
			detail: "profile dir missing, will init via dsh --dump-config"
		});
		try {
			await execAsync("dsh --profile " + profile + " --dump-default-config", { timeout: 3e4 });
			if (existsSync(profileDir)) {
				journal.manual("profile", "profile initialized via dsh --dump-default-config (manual compensation if needed)");
				actions.push({
					kind: "profile",
					status: "applied",
					detail: "initialized profile: " + profile
				});
			}
		} catch (e) {
			actions.push({
				kind: "profile",
				status: "failed",
				detail: "profile init failed",
				hint: e?.message
			});
		}
	}
	const patchPath = join(profileDir, "cordis.patch.yml");
	if (existsSync(patchPath)) actions.push({
		kind: "config",
		status: "info",
		detail: "cordis.patch.yml present, left untouched"
	});
	else try {
		journal.createFile(patchPath, "[]\n", "config", "created empty cordis.patch.yml");
		actions.push({
			kind: "config",
			status: "applied",
			detail: "created empty cordis.patch.yml"
		});
	} catch (e) {
		actions.push({
			kind: "config",
			status: "failed",
			detail: "failed to create cordis.patch.yml",
			hint: e?.message
		});
	}
	const wsPath = join(profileDir, "pnpm-workspace.yaml");
	if (existsSync(wsPath)) try {
		let ws = readFileSync(wsPath, "utf8");
		if (ws.includes("set this to true or false")) {
			ws = ws.replace(/cloudflared: set this to true or false/g, "cloudflared: true");
			ws = ws.replace(/cpu-features: set this to true or false/g, "cpu-features: true");
			ws = ws.replace(/ssh2: set this to true or false/g, "ssh2: true");
			journal.overwriteFile(wsPath, ws, "config", "fixed allowBuilds placeholder");
			actions.push({
				kind: "config",
				status: "applied",
				detail: "fixed allowBuilds placeholder (reversible)"
			});
		} else actions.push({
			kind: "config",
			status: "info",
			detail: "allowBuilds already configured"
		});
	} catch (e) {
		actions.push({
			kind: "config",
			status: "failed",
			detail: "failed to fix allowBuilds",
			hint: e?.message
		});
	}
	const pkgPath = join(profileDir, "package.json");
	if (existsSync(pkgPath)) try {
		JSON.parse(readFileSync(pkgPath, "utf8"));
		actions.push({
			kind: "config",
			status: "info",
			detail: "package.json valid, left untouched"
		});
	} catch {
		journal.manual("config", "package.json is corrupted; rebuild manually or re-init the profile");
		actions.push({
			kind: "config",
			status: "failed",
			detail: "package.json is corrupted",
			hint: "Rebuild package.json manually or re-init the profile"
		});
	}
	if (scope === "deps" || scope === "full") {
		if (existsSync(profileDir)) {
			actions.push({
				kind: "deps",
				status: "info",
				detail: "running pnpm install"
			});
			try {
				await execAsync("pnpm install --fix-lockfile", {
					timeout: 3e5,
					cwd: profileDir
				});
				journal.manual("deps", "pnpm install --fix-lockfile (dependency changes are not auto-reversible)");
				actions.push({
					kind: "deps",
					status: "applied",
					detail: "pnpm install succeeded"
				});
			} catch (e) {
				actions.push({
					kind: "deps",
					status: "failed",
					detail: "pnpm install failed",
					hint: e?.message ?? String(e)
				});
			}
		}
	}
	if (scope === "full") {
		actions.push({
			kind: "process",
			status: "info",
			detail: "process cleanup requested (scope full)"
		});
		if (await checkHealth(port)) actions.push({
			kind: "process",
			status: "skipped",
			detail: "DSH is healthy (HTTP 200), skipping process cleanup"
		});
		else try {
			await stopDshProcesses();
			journal.manual("process", "stopped residual DSH processes (restart manually if needed)");
			actions.push({
				kind: "process",
				status: "applied",
				detail: "stopped residual DSH processes"
			});
		} catch (e) {
			actions.push({
				kind: "process",
				status: "failed",
				detail: "failed to stop residual processes",
				hint: e?.message
			});
		}
	}
	journal.persist();
	const appliedCount = actions.filter((a) => a.status === "applied").length;
	const failedCount = actions.filter((a) => a.status === "failed").length;
	return {
		profile,
		scope,
		actions,
		appliedCount,
		failedCount,
		summary: failedCount === 0 ? "Repair completed without failures." : failedCount + " repair action(s) failed; review hints.",
		journalId: journal.id
	};
}
async function checkHealth(port) {
	const http = await import("node:http");
	return new Promise((resolve) => {
		const req = http.get({
			host: "127.0.0.1",
			port,
			path: "/",
			timeout: 3e3
		}, (res) => {
			resolve(res.statusCode === 200);
			res.resume();
		});
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
		req.on("error", () => resolve(false));
	});
}
async function stopDshProcesses() {
	if (process.platform === "win32") {
		const { execFileSync } = await import("node:child_process");
		try {
			execFileSync("powershell", [
				"-NoProfile",
				"-Command",
				"Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'dsh.*web|bin.js web' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
			], { timeout: 3e4 });
		} catch {}
	} else try {
		await execFileAsync("pkill", ["-f", "dsh.*web"], { timeout: 15e3 });
	} catch {}
}
//#endregion
//#region src/tool.ts
/**
* Model-facing tools: dsh_doctor (diagnose), dsh_doctor_fix (journaled repair),
* and dsh_doctor_rollback (LIFO undo of a repair).
*
* @module @jorinyang/dsh-doctor/tool
*/
const DOCTOR_TOOL_NAME = "dsh_doctor";
const DOCTOR_FIX_TOOL_NAME = "dsh_doctor_fix";
const DOCTOR_ROLLBACK_TOOL_NAME = "dsh_doctor_rollback";
const DIAGNOSE_DESCRIPTION = "Diagnose the DeepSeek Harness (DSH) environment and report startup issues. Checks: Node.js/pnpm/dsh versions, DSH home structure, profile files, config syntax, bundle dependencies and links, config mount (--dump-config), port availability, HTTP health, and disk space. Read-only: returns a structured report with per-check pass/fail/warn status and fix hints. Use before debugging why DSH will not start. To actually fix issues, call dsh_doctor_fix.";
const FIX_DESCRIPTION = "Repair DeepSeek Harness (DSH) startup issues found by dsh_doctor. Mutating, idempotent, and JOURNALED: every reversible change (created dirs/files, edited config) is recorded with an undo step, so the whole run can be rolled back via dsh_doctor_rollback. Creates missing directories, fixes pnpm-workspace.yaml allowBuilds placeholders, creates a missing cordis.patch.yml, and (scope deps/full) runs pnpm install. Scope controls risk: safe = files/config only; deps = + pnpm install; full = + stop residual processes (skipped when DSH is healthy). Prefer safe first, then escalate. Run dsh_doctor first to see what is broken, then call this with the matching scope. The report returns a journalId; pass it to dsh_doctor_rollback to undo.";
const ROLLBACK_DESCRIPTION = "Undo a previous dsh_doctor_fix run by replaying its recorded reversible effects in reverse (LIFO). Each fix is journaled; rollback restores overwritten files, deletes created files/dirs, and reports which steps need manual compensation (e.g. pnpm install, killed processes). Call with no id to roll back the most recent journal, or pass the journalId returned by dsh_doctor_fix. Use dsh_doctor_rollback with action=list to see all journals first.";
function doctorTool() {
	return defineTool({
		name: DOCTOR_TOOL_NAME,
		description: DIAGNOSE_DESCRIPTION,
		parameters: {
			profile: {
				type: "string",
				description: "DSH profile to inspect. Defaults to \"web\"."
			},
			port: {
				type: "integer",
				description: "Web port to check. Defaults to 3080."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					profile: {
						type: "string",
						required: true
					},
					port: {
						type: "integer",
						required: true
					},
					dshHome: {
						type: "string",
						required: true
					},
					checks: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								kind: {
									type: "string",
									required: true
								},
								status: {
									type: "string",
									required: true,
									enum: [
										"ok",
										"fail",
										"warn"
									]
								},
								detail: {
									type: "string",
									required: true
								},
								fixHint: { type: "string" }
							}
						}
					},
					passCount: {
						type: "integer",
						required: true
					},
					failCount: {
						type: "integer",
						required: true
					},
					warnCount: {
						type: "integer",
						required: true
					},
					summary: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderDiagnostic(value)
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args, _exec) {
			return await runDiagnostic(args.profile?.trim() || "web", args.port ?? 3080);
		},
		presentCall: () => ({
			card: "generic",
			title: "Diagnose DSH",
			kind: "other"
		})
	});
}
function doctorFixTool() {
	return defineTool({
		name: DOCTOR_FIX_TOOL_NAME,
		description: FIX_DESCRIPTION,
		parameters: {
			profile: {
				type: "string",
				description: "DSH profile to repair. Defaults to \"web\"."
			},
			port: {
				type: "integer",
				description: "Web port used for the health guard. Defaults to 3080."
			},
			scope: {
				type: "string",
				enum: [
					"safe",
					"deps",
					"full"
				],
				description: "Repair scope: safe (files/config only, recommended first), deps (adds pnpm install), full (adds residual process cleanup). Defaults to safe."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					profile: {
						type: "string",
						required: true
					},
					scope: {
						type: "string",
						required: true,
						enum: [
							"safe",
							"deps",
							"full"
						]
					},
					actions: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								kind: {
									type: "string",
									required: true
								},
								status: {
									type: "string",
									required: true,
									enum: [
										"applied",
										"skipped",
										"failed",
										"info"
									]
								},
								detail: {
									type: "string",
									required: true
								},
								hint: { type: "string" }
							}
						}
					},
					appliedCount: {
						type: "integer",
						required: true
					},
					failedCount: {
						type: "integer",
						required: true
					},
					summary: {
						type: "string",
						required: true
					},
					journalId: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderRepair(value)
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args, _exec) {
			const scope = args.scope ?? "safe";
			return await runRepair(args.profile?.trim() || "web", args.port ?? 3080, scope);
		},
		presentCall: () => ({
			card: "generic",
			title: "Repair DSH",
			kind: "other"
		})
	});
}
function doctorRollbackTool() {
	return defineTool({
		name: DOCTOR_ROLLBACK_TOOL_NAME,
		description: ROLLBACK_DESCRIPTION,
		parameters: {
			id: {
				type: "string",
				description: "Journal id from dsh_doctor_fix. Omit to roll back the most recent."
			},
			action: {
				type: "string",
				enum: ["rollback", "list"],
				description: "rollback (default) undoes a journal; list shows all journals."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					journals: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: {
									type: "string",
									required: true
								},
								createdAt: {
									type: "string",
									required: true
								},
								profile: {
									type: "string",
									required: true
								},
								scope: {
									type: "string",
									required: true
								},
								entryCount: {
									type: "integer",
									required: true
								}
							}
						}
					},
					result: {
						type: "object",
						additionalProperties: false,
						properties: {
							journalId: {
								type: "string",
								required: true
							},
							undoneCount: {
								type: "integer",
								required: true
							},
							failedCount: {
								type: "integer",
								required: true
							},
							manualCount: {
								type: "integer",
								required: true
							},
							summary: {
								type: "string",
								required: true
							}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: renderRollback(value)
			}]
		},
		isConcurrencySafe: () => false,
		async execute(args, _exec) {
			const journals = listJournals().map((j) => ({
				id: j.id,
				createdAt: j.createdAt,
				profile: j.profile,
				scope: j.scope,
				entryCount: j.entries.length
			}));
			if (args.action === "list") return { journals };
			const raw = rollbackJournal(args.id || "");
			if (raw === null) return { journals };
			return {
				journals,
				result: {
					journalId: raw.journalId,
					undoneCount: raw.undoneCount,
					failedCount: raw.failedCount,
					manualCount: raw.manualCount,
					summary: raw.summary
				}
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "Rollback DSH repair",
			kind: "other"
		})
	});
}
function renderDiagnostic(value) {
	const lines = [];
	lines.push("DSH diagnostic report (profile: " + value.profile + ", port: " + value.port + ")");
	lines.push("DSH home: " + value.dshHome);
	lines.push("");
	for (const c of value.checks) {
		const mark = c.status === "ok" ? "[OK]" : c.status === "fail" ? "[XX]" : "[--]";
		lines.push("  " + mark + " " + c.detail);
		if (c.fixHint) lines.push("      fix: " + c.fixHint);
	}
	lines.push("");
	lines.push("Pass: " + value.passCount + "  Fail: " + value.failCount + "  Warn: " + value.warnCount);
	lines.push(value.summary);
	return lines.join("\n");
}
function renderRepair(value) {
	const lines = [];
	lines.push("DSH repair report (profile: " + value.profile + ", scope: " + value.scope + ")");
	lines.push("");
	for (const a of value.actions) {
		const mark = a.status === "applied" ? "[FIX]" : a.status === "failed" ? "[XX]" : a.status === "skipped" ? "[SKIP]" : "[--]";
		lines.push("  " + mark + " " + a.detail);
		if (a.hint) lines.push("      hint: " + a.hint);
	}
	lines.push("");
	lines.push("Applied: " + value.appliedCount + "  Failed: " + value.failedCount);
	if (value.journalId) lines.push("Journal: " + value.journalId + "  (roll back with dsh_doctor_rollback)");
	lines.push(value.summary);
	return lines.join("\n");
}
function renderRollback(value) {
	const lines = [];
	if (value.result) {
		const r = value.result;
		lines.push("DSH rollback result (journal: " + r.journalId + ")");
		lines.push("Undone: " + r.undoneCount + "  Failed: " + r.failedCount + "  Manual: " + r.manualCount);
		lines.push(r.summary);
	} else {
		lines.push("DSH repair journals:");
		for (const j of value.journals) lines.push("  " + j.id + "  (" + j.profile + ", " + j.scope + ", " + j.entryCount + " steps)");
		if (value.journals.length === 0) lines.push("  (none)");
	}
	return lines.join("\n");
}
//#endregion
//#region src/runtime.ts
/** Fiber lifecycle states (cordis FiberState enum, numeric values). */
const FIBER_ACTIVE = 2;
const FIBER_FAILED = 3;
/**
* Install the runtime service on a Cordis context.
* All resources are owned by the fiber via ctx.effect, so they auto-dispose
* when dsh-doctor unloads (reversible effects).
*/
function installRuntime(ctx, config) {
	const failures = [];
	ctx.effect(() => {
		const disposeService = ctx.provide("dsh-doctor", {
			diagnose: (profile, port) => runDiagnostic(profile?.trim() || "web", port ?? config.defaultPort),
			repair: (profile, port, scope) => runRepair(profile?.trim() || "web", port ?? config.defaultPort, scope ?? "safe"),
			rollback: (id) => {
				if (id) return rollbackJournal(id);
				const all = listJournals();
				return all.length > 0 ? rollbackJournal(all[0].id) : null;
			},
			journals: () => listJournals(),
			failures: () => failures.slice()
		});
		const offStatus = ctx.on("internal/status", (fiber, oldState) => {
			if (fiber.state === FIBER_FAILED) {
				failures.push({
					fiberName: fiber.name ?? "unknown",
					at: (/* @__PURE__ */ new Date()).toISOString(),
					state: fiber.state
				});
				ctx.logger("dsh-doctor").warn("plugin fiber entered FAILED: " + fiber.name);
				ctx.emit("dsh-doctor/fiber-failed", fiber.name, fiber.state);
			}
			if (fiber.state === FIBER_ACTIVE && oldState === FIBER_FAILED) {
				ctx.logger("dsh-doctor").info("plugin fiber recovered: " + fiber.name);
				ctx.emit("dsh-doctor/fiber-recovered", fiber.name);
			}
		});
		return () => {
			offStatus();
			disposeService();
			failures.length = 0;
		};
	}, "dsh-doctor-runtime");
}
//#endregion
//#region src/index.ts
/** Cordis plugin name. */
const name = "dsh-doctor";
/** Required services: the tool registry only (runtime service uses ctx.provide). */
const inject = ["tools"];
/** Schemastery configuration validated by the Loader. */
const Config = z.object({ defaultPort: z.natural().default(3080) });
/**
* Register the dsh_doctor / dsh_doctor_fix / dsh_doctor_rollback tools and
* install the runtime service on the Cordis context.
* @param ctx - registrant context.
*/
function apply(ctx, config) {
	ctx.tools.register(doctorTool());
	ctx.tools.register(doctorFixTool());
	ctx.tools.register(doctorRollbackTool());
	installRuntime(ctx, config);
}
//#endregion
export { Config, DOCTOR_FIX_TOOL_NAME, DOCTOR_ROLLBACK_TOOL_NAME, DOCTOR_TOOL_NAME, JournalCollector, apply, inject, installRuntime, listJournals, name, rollbackJournal, runDiagnostic, runRepair };
