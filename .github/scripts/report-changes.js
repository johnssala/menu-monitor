const fs = require("fs");
const { execSync } = require("child_process");

const changes = JSON.parse(fs.readFileSync("changed-report.json", "utf8"));

if (!changes.length) {
  console.log("No changes to report.");
  process.exit(0);
}

for (const change of changes) {
  let title;
  let body;

  if (change.error) {
    title = `Broken menu link: ${change.name} at ${change.park}`;

    body = [
      `The menu page could not be loaded.`,
      ``,
      `**Location:** ${change.park}`,
      `**Restaurant:** ${change.name}`,
      `**URL:** ${change.url}`,
      ``,
      `**Error:**`,
      `${change.error}`,
      ``,
      `This likely means the page was removed, moved, or changed structure.`
    ].join("\n");
  } else {
    title = `Menu changed: ${change.name} (${change.park})`;

    body = [
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
  }

  const tmpFile = "issue-body.txt";
  fs.writeFileSync(tmpFile, body);

  execSync(
    `gh issue create --title ${JSON.stringify(title)} --body-file ${tmpFile}`,
    { stdio: "inherit" }
  );
}