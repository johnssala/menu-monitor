const fs = require("fs");
const { execSync } = require("child_process");

const changes = JSON.parse(fs.readFileSync("changed-report.json", "utf8"));

if (!changes.length) {
  console.log("No changes to report.");
  process.exit(0);
}

for (const change of changes) {
  const title = `Menu changed: ${change.name} (${change.park})`;

  const body = [
    `A change was detected for **${change.name}** in **${change.park}**.`,
    ``,
    `Source: ${change.url}`,
    ``,
    `### Added`,
    ...(change.added.length ? change.added.map(x => `- ${x}`) : ["- None"]),
    ``,
    `### Removed`,
    ...(change.removed.length ? change.removed.map(x => `- ${x}`) : ["- None"])
  ].join("\n");

  const tmpFile = "issue-body.txt";
  fs.writeFileSync(tmpFile, body);

  execSync(
    `gh issue create --title ${JSON.stringify(title)} --body-file ${tmpFile}`,
    { stdio: "inherit" }
  );
}