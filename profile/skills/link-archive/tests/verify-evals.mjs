import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.argv[2];
assert.ok(root, 'provide the external evaluation output directory');
const expected = {'link-archive':2,'session-archive':2,'my-wiki-link':3,'article-ingest':1,'wiki-knowledge-loop':2};
const summary = [];
for (const [name, count] of Object.entries(expected)) {
  const result = JSON.parse(await fs.readFile(path.join(root, `eval-${name}`, 'iteration-1', 'result.json'), 'utf8'));
  assert.equal(result.skill_name, name);
  assert.equal(result.engine_name, 'codex');
  assert.equal(result.case_results.length, count);
  for (const item of result.case_results) {
    assert.equal(item.status, 'PASS');
    assert.equal(item.grading.status, 'PASS');
    assert.ok(item.response.length > 0);
    assert.ok(item.grading.assertion_results.length > 0);
    assert.ok(item.grading.assertion_results.every(a => a.passed === true));
  }
  summary.push({skill:name, passed:count});
}
console.log(JSON.stringify({ok:true, evaluations:summary}));
