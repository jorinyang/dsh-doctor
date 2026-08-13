import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";
//#region src/diagnose.ts
/**
* dsh-doctor diagnosis engine: read-only checks returning a structured report.
* All checks are read-only; the tool returns fix hints rather than mutating state.
*
* @module @dsh-external/dsh-doctor/diagnose
*/
const execFileAsync$1 = promisify(execFile);
const execAsync$1 = promisify(exec);
function resolveDshHome$1() {
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
	const dshHome = resolveDshHome$1();
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
//#region src/repair.ts
/**
* dsh-doctor repair engine: applies safe, dependency, and process repairs.
* Every mutating action is idempotent and backs up before overwriting.
*
* @module @dsh-external/dsh-doctor/repair
*/
const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
function resolveDshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
function timestamp() {
	return (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
}
function backup(path) {
	try {
		const bak = path + ".bak." + timestamp();
		copyFileSync(path, bak);
		return bak;
	} catch {
		return null;
	}
}
/** Run the repair. All actions are idempotent. */
async function runRepair(profile, port, scope) {
	const dshHome = resolveDshHome();
	const profileDir = join(dshHome, "profiles", profile);
	const actions = [];
	if (!existsSync(dshHome)) try {
		mkdirSync(dshHome, { recursive: true });
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
			mkdirSync(p, { recursive: true });
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
			if (existsSync(profileDir)) actions.push({
				kind: "profile",
				status: "applied",
				detail: "initialized profile: " + profile
			});
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
		detail: "cordis.patch.yml present, left untouched (backup-on-demand)"
	});
	else try {
		writeFileSync(patchPath, "[]\n");
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
			const bak = backup(wsPath);
			ws = ws.replace(/cloudflared: set this to true or false/g, "cloudflared: true");
			ws = ws.replace(/cpu-features: set this to true or false/g, "cpu-features: true");
			ws = ws.replace(/ssh2: set this to true or false/g, "ssh2: true");
			writeFileSync(wsPath, ws);
			actions.push({
				kind: "config",
				status: "applied",
				detail: "fixed allowBuilds placeholder" + (bak ? " (backup: " + bak + ")" : "")
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
		const bak = backup(pkgPath);
		actions.push({
			kind: "config",
			status: "failed",
			detail: "package.json is corrupted" + (bak ? " (backed up to " + bak + ")" : ""),
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
	const appliedCount = actions.filter((a) => a.status === "applied").length;
	const failedCount = actions.filter((a) => a.status === "failed").length;
	return {
		profile,
		scope,
		actions,
		appliedCount,
		failedCount,
		summary: failedCount === 0 ? "Repair completed without failures." : failedCount + " repair action(s) failed; review hints."
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
* Model-facing tools: dsh_doctor (read-only diagnostic) and
* dsh_doctor_fix (repair with safe/deps/full scope).
*
* @module @dsh-external/dsh-doctor/tool
*/
const DOCTOR_TOOL_NAME = "dsh_doctor";
const DOCTOR_FIX_TOOL_NAME = "dsh_doctor_fix";
const DIAGNOSE_DESCRIPTION = "Diagnose the DeepSeek Harness (DSH) environment and report startup issues. Checks: Node.js/pnpm/dsh versions, DSH home structure, profile files, config syntax, bundle dependencies and links, config mount (--dump-config), port availability, HTTP health, and disk space. Read-only: returns a structured report with per-check pass/fail/warn status and fix hints. Use before debugging why DSH will not start. To actually fix issues, call dsh_doctor_fix.";
const FIX_DESCRIPTION = "Repair DeepSeek Harness (DSH) startup issues found by dsh_doctor. Mutating and idempotent: creates missing directories, fixes pnpm-workspace.yaml allowBuilds placeholders, backs up and resets a corrupted cordis.patch.yml, and (scope deps/full) runs pnpm install. Scope controls risk: safe = files/config only; deps = + pnpm install; full = + stop residual processes (skipped when DSH is healthy). Prefer safe first, then escalate. Run dsh_doctor first to see what is broken, then call this with the matching scope.";
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
					}
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
	lines.push(value.summary);
	return lines.join("\n");
}
//#endregion
//#region src/index.ts
/** Cordis plugin name. */
const name = "dsh-doctor";
/** Required services: the tool registry only. */
const inject = ["tools"];
/** Schemastery configuration validated by the Loader. */
const Config = z.object({ defaultPort: z.natural().default(3080) });
/**
* Register the dsh_doctor and dsh_doctor_fix tools.
* @param ctx - registrant context.
*/
function apply(ctx) {
	ctx.tools.register(doctorTool());
	ctx.tools.register(doctorFixTool());
}
//#endregion
export { Config, DOCTOR_FIX_TOOL_NAME, DOCTOR_TOOL_NAME, apply, inject, name };
