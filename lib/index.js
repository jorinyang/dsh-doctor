import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
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
const execFileAsync = promisify(execFile);
function resolveDshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
async function runVersion(cmd, args) {
	try {
		const { stdout } = await execFileAsync(cmd, args, {
			timeout: 1e4,
			shell: process.platform === "win32"
		});
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
function checkHealth(port) {
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
	const dshHome = resolveDshHome();
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
		const { stdout } = await execFileAsync("dsh", [
			"--profile",
			profile,
			"--dump-config"
		], {
			timeout: 3e4,
			shell: process.platform === "win32"
		});
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
	const health = await checkHealth(port);
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
			const { stdout } = await execFileAsync("df", ["-h", dshHome], { timeout: 1e4 });
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
//#region src/tool.ts
/**
* The model-facing `dsh_doctor` tool: run a read-only diagnostic across
* environment, profile, config, bundles, mount, port, health, and disk,
* returning a structured report with fix hints.
*
* @module @dsh-external/dsh-doctor/tool
*/
const DOCTOR_TOOL_NAME = "dsh_doctor";
const DESCRIPTION = "Diagnose the DeepSeek Harness (DSH) environment and report startup issues. Checks: Node.js/pnpm/dsh versions, DSH home structure, profile files, config syntax, bundle dependencies and links, config mount (--dump-config), port availability, HTTP health, and disk space. Read-only: returns a structured report with per-check pass/fail/warn status and fix hints. Use before debugging why DSH will not start, or to verify a healthy installation. Apply repairs through the shell tool, not here.";
function doctorTool() {
	return defineTool({
		name: DOCTOR_TOOL_NAME,
		description: DESCRIPTION,
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
				text: renderReport(value)
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
function renderReport(value) {
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
//#endregion
//#region src/index.ts
/** Cordis plugin name. */
const name = "dsh-doctor";
/** Required services: the tool registry only. */
const inject = ["tools"];
/** Schemastery configuration validated by the Loader. */
const Config = z.object({ defaultPort: z.natural().default(3080) });
/**
* Register the dsh_doctor tool.
* @param ctx - registrant context.
*/
function apply(ctx) {
	ctx.tools.register(doctorTool());
}
//#endregion
export { Config, DOCTOR_TOOL_NAME, apply, inject, name };
