// Real treasury spenders only: a node process running *treasury-fund*.mjs / fund-tn10-test.mjs / a tn10-million-test script,
// or a bash/sh process executing a script FILE with such a name. Excludes treasury-fund-r1.mjs and the given pid.
// (Shell one-liners that merely mention these names in their text are not spenders.)
import fs from "node:fs";
export function otherSpenders(selfPid) {
  const res = [];
  const hit = (a) => /(treasury-fund[^\/\s]*\.(mjs|js|sh)|fund-tn10-test\.mjs|tn10-million-test\/\S*\.(mjs|js|sh))$/.test(a) && !/treasury-fund-r1\.mjs$/.test(a);
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d) || +d === selfPid) continue;
    let argv; try { argv = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { continue; }
    if (!argv.length) continue;
    const exe = argv[0].split("/").pop();
    if (exe.startsWith("node") && argv.slice(1).some((a) => !a.startsWith("-") && hit(a))) res.push(`${d} ${argv.join(" ").slice(0, 140)}`);
    else if ((exe === "bash" || exe === "sh") && argv[1] && !argv[1].startsWith("-") && hit(argv[1])) res.push(`${d} ${argv.join(" ").slice(0, 140)}`);
  }
  return res;
}
