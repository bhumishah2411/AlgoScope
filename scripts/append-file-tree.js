// scripts/append-file-tree.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const dirTree = require('directory-tree');

// Get the new tag from the command line argument
const tag = process.argv[2];
if (!tag) {
  console.error('No tag provided');
  process.exit(1);
}

// Find the previous tag
let previousTag;
try {
  previousTag = execSync(`git describe --tags --abbrev=0 ${tag}^`, { encoding: 'utf8' }).trim();
} catch {
  // This is the very first tag – no previous tag exists
  previousTag = null;
}

// Build a filtered directory tree containing only files changed between previousTag and tag
let changedFiles = [];
if (previousTag) {
  const diffOutput = execSync(`git diff --name-status ${previousTag} ${tag}`, { encoding: 'utf8' });
  changedFiles = diffOutput
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const [status, ...fileParts] = line.split('\t');
      return { status, file: fileParts.join('\t') };
    });
} else {
  // First release: include all files tracked by git
  const allFiles = execSync('git ls-tree -r HEAD --name-only', { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map(f => ({ status: 'A', file: f }));
  changedFiles = allFiles;
}

// Generate a markdown file tree from the changed file list.
// We build a nested object representing the directory structure.
function buildTree(fileList) {
  const root = {};
  for (const entry of fileList) {
    const parts = entry.file.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        // It's a file: mark with the status
        if (!current[part]) {
          current[part] = { type: 'file', status: entry.status };
        }
      } else {
        if (!current[part]) {
          current[part] = { type: 'directory', children: {} };
        } else if (current[part].type !== 'directory') {
          // Conflict – should not happen
          current[part] = { type: 'directory', children: {} };
        }
        current = current[part].children;
      }
    }
  }
  return root;
}

function renderTree(node, indent = '') {
  let output = '';
  const entries = Object.entries(node).sort((a, b) => {
    // Directories first, then files, then alphabetical
    const aIsDir = a[1].type === 'directory';
    const bIsDir = b[1].type === 'directory';
    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;
    return a[0].localeCompare(b[0]);
  });

  for (const [name, info] of entries) {
    if (info.type === 'directory') {
      output += `${indent}- 📁 **${name}/**\n`;
      output += renderTree(info.children, indent + '  ');
    } else {
      // File – show status icon
      let icon = '';
      if (info.status === 'A') icon = '➕ ';
      else if (info.status === 'M') icon = '✏️ ';
      else if (info.status === 'D') icon = '❌ ';
      else icon = '• ';
      output += `${indent}- ${icon}${name}\n`;
    }
  }
  return output;
}

const tree = buildTree(changedFiles);
const treeMarkdown = renderTree(tree);

// Read the existing CHANGELOG.md
const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
let changelog = fs.readFileSync(changelogPath, 'utf8');

// Locate the header for this specific release version and insert the file tree after it.
// The version header looks like: "## [1.5.0](...) (YYYY-MM-DD)" or "## [1.5.0] - YYYY-MM-DD"
const version = tag.startsWith('v') ? tag.slice(1) : tag;
const headerRegex = new RegExp(`^## \\[${version}\\].*$`, 'm');
const match = changelog.match(headerRegex);

if (!match) {
  console.error(`Could not find header for version ${version} in CHANGELOG.md`);
  process.exit(1);
}

const headerLine = match[0];
const headerIndex = changelog.indexOf(headerLine);

// Find the start of the next release section (or end of file) to know where to insert
const nextHeaderRegex = /^## \[/m;
const restOfFile = changelog.slice(headerIndex + headerLine.length);
const nextMatch = restOfFile.match(nextHeaderRegex);
const insertionEnd = nextMatch
  ? headerIndex + headerLine.length + nextMatch.index
  : changelog.length;

// Build the file-tree section
const treeSection = `\n### 📂 Changed Files\n\n\`\`\`\n${treeMarkdown}\`\`\`\n`;

// Insert the tree section right after the release header and its description (before the first category)
// Strategy: find the first "### " heading after the release header, and insert before it.
const afterHeaderContent = changelog.slice(headerIndex + headerLine.length, insertionEnd);
const firstCategoryIndex = afterHeaderContent.search(/^### /m);
let finalChangelog;
if (firstCategoryIndex !== -1) {
  // Insert before that first category heading
  finalChangelog =
    changelog.slice(0, headerIndex + headerLine.length) +
    afterHeaderContent.slice(0, firstCategoryIndex) +
    treeSection +
    afterHeaderContent.slice(firstCategoryIndex) +
    changelog.slice(insertionEnd);
} else {
  // No category headings – insert after the header line
  finalChangelog =
    changelog.slice(0, headerIndex + headerLine.length) +
    treeSection +
    changelog.slice(headerIndex + headerLine.length);
}

fs.writeFileSync(changelogPath, finalChangelog, 'utf8');
console.log('Updated CHANGELOG.md with changed-files tree.');
