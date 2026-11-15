#!/usr/bin/env node
'use strict';
// Optional: re-points the project at a different GitHub account/repository (e.g. for a fork).
//   node tools/setup.js NEW-USERNAME [new-repository-name]
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const [user, repo = 'sulfur-interactive-cookbook'] = process.argv.slice(2);
if (!user || !/^[A-Za-z0-9-]+$/.test(user) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
  console.error('Usage: node tools/setup.js NEW-USERNAME [new-repository-name]');
  process.exit(1);
}
const cfgFile = path.join(root, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const [oldUser, oldRepo] = cfg.repo.split('/');
const edit = (file, fn) => { const f = path.join(root, file); if (fs.existsSync(f)) fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8'))); };
const swap = (s) => s.split(`${oldUser}/${oldRepo}`).join(`${user}/${repo}`).split(oldUser).join(user);

cfg.repo = `${user}/${repo}`;
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
edit('package.json', (s) => {
  const p = JSON.parse(s);
  p.author = user;
  p.repository.url = `https://github.com/${user}/${repo}.git`;
  p.build.appId = `io.github.${user.toLowerCase()}.${repo.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  p.build.publish = [{ provider: 'github', owner: user, repo, releaseType: 'release' }];
  return JSON.stringify(p, null, 2) + '\n';
});
for (const f of ['README.md', 'CONTRIBUTING.md', 'LICENSE', 'src/server.js', 'tools/scrape.py']) edit(f, swap);
console.log(`Done: the project now points to https://github.com/${user}/${repo}`);
