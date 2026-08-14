#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path, { dirname, join } from "node:path";
import { exec, execFile, execSync } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
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
//#region src/cli.ts
/**
* dsh-doctor CLI: standalone command-line entry for diagnose, repair, and rollback.
*
* Usage:
*   dsh-doctor                     # diagnose (read-only)
*   dsh-doctor diagnose            # same
*   dsh-doctor fix                 # repair with scope=safe (journaled)
*   dsh-doctor fix --scope deps    # repair with scope=deps
*   dsh-doctor fix --scope full    # repair with scope=full
*   dsh-doctor rollback            # undo the most recent repair (LIFO)
*   dsh-doctor rollback --list     # list journals
*   dsh-doctor rollback --id <id>  # undo a specific journal
*   dsh-doctor setup               # register to system PATH
*
* Options:
*   --profile <name>   DSH profile (default: web)
*   --port <number>    web port to check (default: 3080)
*   --scope <level>    repair scope: safe | deps | full (default: safe)
*   -h, --help         show help
*   -V, --version      show version
*/
const isTTY = process.stdout.isTTY;
const c = {
	reset: isTTY ? "\x1B[0m" : "",
	bold: isTTY ? "\x1B[1m" : "",
	dim: isTTY ? "\x1B[2m" : "",
	red: isTTY ? "\x1B[31m" : "",
	green: isTTY ? "\x1B[32m" : "",
	yellow: isTTY ? "\x1B[33m" : "",
	cyan: isTTY ? "\x1B[36m" : "",
	white: isTTY ? "\x1B[37m" : ""
};
function mark(status) {
	switch (status) {
		case "ok": return c.green + "[OK] " + c.reset;
		case "fail": return c.red + "[XX] " + c.reset;
		case "warn": return c.yellow + "[--] " + c.reset;
		case "applied": return c.green + "[FIX]" + c.reset;
		case "skipped": return c.dim + "[SKIP]" + c.reset;
		case "failed": return c.red + "[XX] " + c.reset;
		case "info": return c.dim + "[--] " + c.reset;
		case "undone": return c.green + "[UNDO]" + c.reset;
		case "manual": return c.yellow + "[MANUAL]" + c.reset;
		default: return "     ";
	}
}
const VERSION = "0.3.1";
function getNpmGlobalBin() {
	try {
		const prefix = execSync("npm config get prefix", {
			encoding: "utf8",
			stdio: "pipe"
		}).trim();
		return process.platform === "win32" ? prefix : join(prefix, "bin");
	} catch {
		return null;
	}
}
function isInPath(dir) {
	const paths = (process.env.PATH || process.env.Path || "").split(path.delimiter);
	const normalizedDir = dir.replace(/\\/g, "/").toLowerCase();
	return paths.some((p) => p.replace(/\\/g, "/").toLowerCase() === normalizedDir);
}
function getShellConfig() {
	const home = homedir();
	const shell = process.env.SHELL || "";
	if (shell.includes("zsh") || existsSync(join(home, ".zshrc"))) return {
		file: join(home, ".zshrc"),
		name: ".zshrc"
	};
	if (shell.includes("bash") || existsSync(join(home, ".bashrc"))) return {
		file: join(home, ".bashrc"),
		name: ".bashrc"
	};
	if (shell.includes("fish")) return {
		file: join(home, ".config", "fish", "config.fish"),
		name: "fish config"
	};
	return {
		file: join(home, ".profile"),
		name: ".profile"
	};
}
function runSetup() {
	const globalBin = getNpmGlobalBin();
	if (!globalBin) {
		console.error(c.red + "Error: Could not determine npm global bin directory." + c.reset);
		console.error(c.dim + "Make sure npm is installed: https://nodejs.org/" + c.reset);
		process.exit(2);
	}
	if (!existsSync(globalBin)) mkdirSync(globalBin, { recursive: true });
	const bundleSource = join(dirname(fileURLToPath(import.meta.url)), "cli.bundle.js");
	if (existsSync(bundleSource)) {
		const bundleDest = join(globalBin, "dsh-doctor-bundle.js");
		copyFileSync(bundleSource, bundleDest);
		if (process.platform === "win32") {
			writeFileSync(join(globalBin, "dsh-doctor.cmd"), "@ECHO off\nnode \"" + bundleDest + "\" %*\n");
			writeFileSync(join(globalBin, "dsh-doctor.ps1"), "& node \"" + bundleDest + "\" @args\n");
		} else {
			const binPath = join(globalBin, "dsh-doctor");
			writeFileSync(binPath, "#!/bin/sh\nexec node \"" + bundleDest + "\" \"$@\"\n", { mode: 493 });
		}
		console.log(c.green + "✓ Installed CLI to: " + globalBin + c.reset);
	} else {
		console.error(c.red + "Error: CLI bundle not found at " + bundleSource + c.reset);
		process.exit(2);
	}
	if (!isInPath(globalBin)) {
		console.log("");
		console.log(c.yellow + "⚠ " + globalBin + " is not in your PATH." + c.reset);
		console.log("");
		if (process.platform === "win32") {
			console.log("To add it, run in PowerShell (as Admin):");
			console.log(c.cyan + "  [Environment]::SetEnvironmentVariable(\"Path\", $env:Path + \";" + globalBin + "\", [EnvironmentVariableTarget]::User)" + c.reset);
		} else {
			const shell = getShellConfig();
			console.log("To add it, add this line to your " + shell.name + ":");
			if (shell.name === "fish config") console.log(c.cyan + "  set -gx PATH " + globalBin + " $PATH" + c.reset);
			else console.log(c.cyan + "  export PATH=\"" + globalBin + ":$PATH\"" + c.reset);
		}
		console.log("");
	} else console.log(c.green + c.bold + "✓ dsh-doctor is ready to use." + c.reset);
}
function parseArgs(argv) {
	const args = {
		command: "diagnose",
		profile: "web",
		port: 3080,
		scope: "safe",
		id: "",
		list: false,
		help: false,
		version: false
	};
	let i = 0;
	while (i < argv.length && !argv[i].startsWith("-")) {
		const tok = argv[i];
		if (tok === "diagnose" || tok === "diag" || tok === "check") args.command = "diagnose";
		else if (tok === "fix" || tok === "repair") args.command = "fix";
		else if (tok === "rollback" || tok === "undo") args.command = "rollback";
		else if (tok === "journals" || tok === "list") {
			args.command = "rollback";
			args.list = true;
		} else if (tok === "setup" || tok === "install" || tok === "register") args.command = "setup";
		i++;
	}
	while (i < argv.length) {
		const tok = argv[i];
		if (tok === "-h" || tok === "--help") args.help = true;
		else if (tok === "-V" || tok === "--version") args.version = true;
		else if (tok === "--list") args.list = true;
		else if (tok === "--profile" && i + 1 < argv.length) args.profile = argv[++i];
		else if (tok.startsWith("--profile=")) args.profile = tok.slice(10);
		else if (tok === "--port" && i + 1 < argv.length) args.port = Number(argv[++i]);
		else if (tok.startsWith("--port=")) args.port = Number(tok.slice(7));
		else if (tok === "--scope" && i + 1 < argv.length) args.scope = argv[++i];
		else if (tok.startsWith("--scope=")) args.scope = tok.slice(8);
		else if (tok === "--id" && i + 1 < argv.length) args.id = argv[++i];
		else if (tok.startsWith("--id=")) args.id = tok.slice(5);
		i++;
	}
	return args;
}
const HELP = `
${c.bold}dsh doctor${c.reset} — DeepSeek Harness diagnostic, repair & rollback CLI

${c.bold}Usage:${c.reset}
  dsh-doctor [command] [options]

${c.bold}Commands:${c.reset}
  diagnose, diag, check   Read-only diagnosis (default)
  fix, repair             Apply journaled repairs (reversible)
  rollback, undo          Undo a repair (LIFO); --list to show journals
  setup, install          Register dsh-doctor command to system PATH

${c.bold}Options:${c.reset}
  --profile <name>        DSH profile to inspect (default: web)
  --port <number>         Web port to check (default: 3080)
  --scope <level>         Repair scope: safe | deps | full (default: safe)
  --id <id>               Journal id for rollback (default: most recent)
  --list                  List journals instead of rolling back
  -h, --help              Show this help
  -V, --version           Show version

${c.bold}Repair scopes:${c.reset}
  safe    Files & config only (recommended first)
  deps    + pnpm install --fix-lockfile
  full    + stop residual DSH processes (skipped when healthy)

${c.bold}Examples:${c.reset}
  dsh-doctor                          # diagnose web profile
  dsh-doctor fix                      # safe repair (journaled)
  dsh-doctor fix --scope deps         # repair + reinstall deps
  dsh-doctor rollback                 # undo the most recent repair
  dsh-doctor rollback --list          # list all repair journals
  dsh-doctor rollback --id doctor-... # undo a specific journal
  dsh-doctor setup                    # register to PATH manually
`;
function renderDiagnostic(value) {
	console.log();
	console.log(c.bold + "DSH Diagnostic Report" + c.reset + c.dim + "  (profile: " + value.profile + ", port: " + value.port + ")" + c.reset);
	console.log(c.dim + "DSH home: " + value.dshHome + c.reset);
	console.log();
	for (const ch of value.checks) {
		console.log("  " + mark(ch.status) + " " + ch.detail);
		if (ch.fixHint) console.log("      " + c.cyan + "fix: " + ch.fixHint + c.reset);
	}
	console.log();
	const pass = c.green + value.passCount + " pass" + c.reset;
	const fail = value.failCount > 0 ? c.red + value.failCount + " fail" + c.reset : c.dim + "0 fail" + c.reset;
	const warn = value.warnCount > 0 ? c.yellow + value.warnCount + " warn" + c.reset : c.dim + "0 warn" + c.reset;
	console.log("  " + pass + "  " + fail + "  " + warn);
	console.log();
	if (value.failCount === 0) console.log(c.green + c.bold + "✓ " + value.summary + c.reset);
	else console.log(c.red + c.bold + "✗ " + value.summary + c.reset);
	console.log();
}
function renderRepair(value) {
	console.log();
	console.log(c.bold + "DSH Repair Report" + c.reset + c.dim + "  (profile: " + value.profile + ", scope: " + value.scope + ")" + c.reset);
	console.log();
	for (const a of value.actions) {
		console.log("  " + mark(a.status) + " " + (a.status === "applied" ? c.green : "") + a.detail + c.reset);
		if (a.hint) console.log("      " + c.cyan + "hint: " + a.hint + c.reset);
	}
	console.log();
	const applied = c.green + value.appliedCount + " applied" + c.reset;
	const failed = value.failedCount > 0 ? c.red + value.failedCount + " failed" + c.reset : c.dim + "0 failed" + c.reset;
	console.log("  " + applied + "  " + failed);
	if (value.journalId) console.log("  " + c.cyan + "journal: " + value.journalId + c.reset + c.dim + "  (undo with: dsh-doctor rollback --id " + value.journalId + ")" + c.reset);
	console.log();
	if (value.failedCount === 0) console.log(c.green + c.bold + "✓ " + value.summary + c.reset);
	else console.log(c.yellow + c.bold + "⚠ " + value.summary + c.reset);
	console.log();
}
function renderRollback(result) {
	console.log();
	console.log(c.bold + "DSH Rollback Result" + c.reset + c.dim + "  (journal: " + result.journalId + ")" + c.reset);
	console.log();
	for (const s of result.steps) console.log("  " + mark(s.status) + " " + s.detail);
	console.log();
	const undone = c.green + result.undoneCount + " undone" + c.reset;
	const failed = result.failedCount > 0 ? c.red + result.failedCount + " failed" + c.reset : c.dim + "0 failed" + c.reset;
	const manual = result.manualCount > 0 ? c.yellow + result.manualCount + " manual" + c.reset : c.dim + "0 manual" + c.reset;
	console.log("  " + undone + "  " + failed + "  " + manual);
	console.log();
	console.log(c.green + c.bold + "✓ " + result.summary + c.reset);
	console.log();
}
function renderJournals() {
	const journals = listJournals();
	console.log();
	console.log(c.bold + "DSH Repair Journals" + c.reset);
	console.log();
	if (journals.length === 0) console.log("  (none)");
	else for (const j of journals) {
		console.log("  " + c.cyan + j.id + c.reset);
		console.log("      " + c.dim + j.createdAt + "  profile=" + j.profile + "  scope=" + j.scope + "  steps=" + j.entries.length + c.reset);
	}
	console.log();
}
async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.command === "setup") {
		runSetup();
		process.exit(0);
	}
	if (args.version) {
		console.log(VERSION);
		process.exit(0);
	}
	if (args.help) {
		console.log(HELP);
		process.exit(0);
	}
	try {
		if (args.command === "diagnose") {
			const report = await runDiagnostic(args.profile, args.port);
			renderDiagnostic(report);
			process.exit(report.failCount > 0 ? 1 : 0);
		} else if (args.command === "fix") {
			const report = await runRepair(args.profile, args.port, args.scope);
			renderRepair(report);
			process.exit(report.failedCount > 0 ? 1 : 0);
		} else {
			if (args.list) {
				renderJournals();
				process.exit(0);
			}
			const result = args.id ? rollbackJournal(args.id) : listJournals().length > 0 ? rollbackJournal(listJournals()[0].id) : null;
			if (result === null) {
				console.error(c.red + "No journal found to roll back." + c.reset);
				process.exit(1);
			}
			renderRollback(result);
			process.exit(result.failedCount > 0 ? 1 : 0);
		}
	} catch (err) {
		console.error(c.red + "Error: " + (err?.message ?? String(err)) + c.reset);
		process.exit(2);
	}
}
main();
//#endregion
export {};
