import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MemoryStore } from "../src/store.ts";
import { reviewEvaluation } from "../src/evaluation.ts";
import { DEFAULT_LIMITS } from "../src/limits.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const dir=()=>mkdtempSync(join(tmpdir(),"pi-candidates-"));
const lesson={text:"Keep the verified project configuration.",evidence:"A repeated clean run confirmed the configuration.",basis:"validated_learning" as const};
const origin=(session:string)=>({harness:"test",session,actor:"user" as const});
const group={candidateIds:[] as number[],text:lesson.text,evidence:lesson.evidence,priority:5,scope:"project" as const,reason:"Confirmed independently",recommend:true};

test("candidate isolation, lineage dedupe, qualification, retained decline and evaluation highwater",t=>{
 const root=dir();t.after(()=>rmSync(root,{recursive:true,force:true}));const store=new MemoryStore(join(root,"db"));t.after(()=>store.close());
 store.stageCandidate("/p/a",lesson,origin("owner-a"),"lineage-a");
 store.stageCandidate("/p/a",lesson,origin("owner-a"),"lineage-a");
 store.stageCandidate("/p/a",{...lesson,evidence:"Owner B verified a separate clean run.",priority:7},origin("owner-b"),"lineage-b");
 store.stageCandidate("/p/a",{...lesson,evidence:"Fork repeated the same discovery."},origin("fork-a"),"lineage-a");
 assert.equal(store.ownCandidates("/p/a","owner-a")[0].observations.length,1);
 assert.equal(store.ownCandidates("/p/a","owner-b")[0].observations[0].wording,lesson.text);
 assert.equal(store.ownCandidates("/p/a","owner-b")[0].evidence,"Owner B verified a separate clean run.");
 assert.equal(store.ownCandidates("/p/a","owner-b")[0].priority,7);
 assert.equal(store.ownCandidates("/p/a","fork-a")[0].evidence,"Fork repeated the same discovery.");
 assert.deepEqual(store.ownCandidates("/p/a","unrelated"),[]);
 assert.equal(store.candidateCounts().pending,1);
 const snap=store.candidateSnapshot();const c=snap.candidates[0];
 assert.deepEqual(store.qualifyCandidateGroup(snap,[c.id],"project"),{occurrences:2,projects:1,eligible:true,resolvedScope:"project"});
 assert.equal(store.qualifyCandidateGroup(snap,[c.id],"global").eligible,false);
 const declined={...group,candidateIds:[c.id]};store.completeCandidateEvaluation(snap,origin("reviewer"),[declined],[]);
 assert.equal(store.candidateSnapshot().evaluations.length,1);assert.equal(store.candidateCounts().sinceEvaluation,0);
 store.stageCandidate("/p/b",lesson,origin("b"),"b-lineage");
 assert.equal(store.candidateCounts().sinceEvaluation,1);
});

test("global thresholds, promotion and stale snapshot rejection are atomic",t=>{
 const root=dir();t.after(()=>rmSync(root,{recursive:true,force:true}));const store=new MemoryStore(join(root,"db"));t.after(()=>store.close());
 for(const [p,k] of [["/p/a","a"],["/p/b","b"],["/p/c","c"],["/p/d","d"]])store.stageCandidate(p,lesson,origin(k),`${k}-lineage`);
 const snap=store.candidateSnapshot(),ids=snap.candidates.map(c=>c.id);
 assert.deepEqual(store.qualifyCandidateGroup(snap,ids,"global"),{occurrences:4,projects:4,eligible:true,resolvedScope:"global"});
 const g={...group,candidateIds:ids,scope:"global" as const};
 store.stageCandidate("/p/a",lesson,origin("another"),"a-second-lineage");
 assert.throws(()=>store.completeCandidateEvaluation(snap,origin("reviewer"),[g],[0]),/stale/);
 store.stageCandidate("/p/e",{...lesson,text:"A separate new pending fact."},origin("e"),"e-lineage");
 const fresh=store.candidateSnapshot(), ids2=fresh.candidates.filter(c=>ids.includes(c.id)).map(c=>c.id);
 const groups=[{...g,candidateIds:ids2},{...group,candidateIds:fresh.candidates.filter(c=>!ids.includes(c.id)).map(c=>c.id)}];
 assert.throws(()=>store.completeCandidateEvaluation(fresh,origin("reviewer"),groups,[0,1]),/qualification/);
 assert.equal(store.list("global").total,0,"a later ineligible approval rolls back earlier promotions");
 assert.equal(store.candidateSnapshot().evaluations.length,0,"failed approvals cannot leave similarity judgments behind");
 const result=store.completeCandidateEvaluation(fresh,origin("reviewer"),groups,[0]);
 assert.equal(result.length,1);assert.equal(store.list("global").total,1);assert.equal(store.candidateCounts().pending,1);
});

test("disclosure excludes future equivalent repetitions without erasing earlier independent discoveries", t => {
  const root = dir(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore(join(root, "db")); t.after(() => store.close());
  store.stageCandidate("/p/a", lesson, origin("discoverer"), "discoverer");
  const before = store.candidateSnapshot();
  store.markCandidateExposure(before, "reviewer");
  store.stageCandidate("/p/a", lesson, origin("reviewer"), "reviewer");
  const reworded = { ...lesson, text: "Preserve the independently verified project configuration." };
  store.stageCandidate("/p/a", reworded, origin("reviewer"), "reviewer");
  store.stageCandidate("/p/a", reworded, origin("peer"), "peer");
  const snapshot = store.candidateSnapshot();
  const ids = snapshot.candidates.map(candidate => candidate.id);
  assert.equal(store.qualifyCandidateGroup(snapshot, ids, "project").occurrences, 2,
    "both evaluator rewordings are excluded, while original discoverer and peer remain independent");
  const disclosedAgain = store.markCandidateExposure(snapshot, "discoverer");
  assert.equal(store.qualifyCandidateGroup(disclosedAgain, ids, "project").occurrences, 2,
    "evaluating a lesson does not invalidate evidence submitted before disclosure");
  // A completely new candidate can arrive while this snapshot is under review.
  store.stageCandidate("/p/b", { ...lesson, text: "Keep another independently discovered configuration." }, origin("new-peer"), "new-peer");
  store.completeCandidateEvaluation(disclosedAgain, origin("reviewer"), [{ ...group, candidateIds: ids }], []);
  assert.deepEqual(store.candidateCounts(), { pending: 3, sinceEvaluation: 1 });
  const raw = new DatabaseSync(join(root, "db"));
  try {
    for (const table of ["candidates", "candidate_observations", "candidate_evaluations", "candidate_evaluation_groups", "candidate_group_members", "candidate_exposures"]) {
      assert.throws(() => raw.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`), /cannot be replaced/);
      assert.throws(() => raw.exec(`DELETE FROM ${table}`), /cannot be deleted/);
    }
    assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { raw.close(); }
});

test("exposure survives promotion and recreated exact identities without changing existing active lessons", t => {
  const root = dir(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore(join(root, "db")); t.after(() => store.close());
  for (const session of ["original-a", "original-b"]) store.stageCandidate("/p/a", lesson, origin(session), session);
  const first = store.markCandidateExposure(store.candidateSnapshot(), "reviewer");
  const promoted = store.completeCandidateEvaluation(first, origin("reviewer"), [{ ...group, candidateIds: first.candidates.map(c => c.id) }], [0]);
  const lessonId = promoted[0].lessonId;
  store.stageCandidate("/p/a", lesson, origin("reviewer"), "reviewer");
  store.stageCandidate("/p/a", lesson, origin("fresh-peer"), "fresh-peer");
  const recreated = store.candidateSnapshot();
  assert.notEqual(recreated.candidates[0].id, first.candidates[0].id);
  assert.equal(recreated.evaluations[0].groups[0].approved, true, "recreated identities retain previous grouping judgments");
  assert.equal(recreated.candidates[0].observations[0].exposed, true);
  assert.equal(store.qualifyCandidateGroup(recreated, recreated.candidates.map(c => c.id), "project").occurrences, 1,
    "the promoted original's disclosure still excludes the evaluator's later repetition");
  store.stageCandidate("/p/a", lesson, origin("second-peer"), "second-peer");
  const fresh = store.candidateSnapshot();
  const repeated = store.completeCandidateEvaluation(fresh, origin("approver"), [{ ...group, priority: 8, candidateIds: fresh.candidates.map(c => c.id) }], [0]);
  assert.deepEqual(repeated, [{ groupIndex: 0, lessonId, created: false }]);
  assert.equal(store.get("/p/a", lessonId).priority, 5, "duplicate promotion cannot rerank an existing lesson");
  assert.equal(store.history("/p/a", lessonId).events.length, 1);
});

test("RPC review uniquely selects and revises identical project suggestions after both are approved", async t => {
  const root = dir(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore(join(root, "db")); t.after(() => store.close());
  for (const project of ["/p/a", "/p/b"]) for (const session of ["first", "second"]) {
    const owner = `${project}-${session}`;
    store.stageCandidate(project, lesson, origin(owner), owner);
  }
  const snapshot = store.candidateSnapshot();
  const groups = snapshot.candidates.map(candidate => ({ ...group, candidateIds: [candidate.id] }));
  const rootSelections = [1, 2, 2, "finish"];
  const decisions = ["Yes — promote", "Yes — promote", "No — keep pending"];
  let opened = 0;
  const ctx = { mode: "rpc", ui: { select: async (title: string, labels: string[]) => {
    assert.equal(new Set(labels).size, labels.length, "RPC labels must always identify exactly one group");
    if (title.startsWith("Review candidate evaluation")) {
      const selected = rootSelections.shift();
      assert.notEqual(selected, undefined);
      return selected === "finish" ? labels.find(label => label.startsWith("Finish evaluation"))!
        : labels.find(label => label.startsWith(`Group ${selected} ·`))!;
    }
    assert.match(title, /^Candidate group/);
    assert.ok(title.includes(opened++ === 0 ? "/p/a" : "/p/b"), "reopening group two must show the second project's evidence");
    return decisions.shift()!;
  } } } as unknown as ExtensionContext;
  const approved = await reviewEvaluation(ctx, snapshot, groups, store, DEFAULT_LIMITS, new AbortController().signal, () => {});
  assert.deepEqual(approved, [0], "No on the reopened second group removes only its own approval");
  assert.equal(rootSelections.length, 0); assert.equal(decisions.length, 0);
  assert.equal(store.list("/p/a").total, 0); assert.equal(store.list("/p/b").total, 0, "review selections alone do not write lessons");
});

test("schema 7 upgrades atomically to candidate schema 8",t=>{
 const root=dir();t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,"db");
 const first=new MemoryStore(path);first.add("/p/a",lesson,origin("x"));first.close();
 const legacy=new DatabaseSync(path);
 legacy.exec("PRAGMA foreign_keys=OFF; DROP TABLE candidate_group_members; DROP TABLE candidate_evaluation_groups; DROP TABLE candidate_evaluations; DROP TABLE candidate_exposures; DROP TABLE candidate_observations; DROP TABLE candidates; DROP TABLE candidate_state; PRAGMA user_version=7");
 legacy.close();
 const upgraded=new MemoryStore(path);t.after(()=>upgraded.close());
 const check=new DatabaseSync(path);try{assert.equal(Number(check.prepare("PRAGMA user_version").get()!.user_version),8);assert.equal(check.prepare("SELECT count(*) n FROM lessons").get()!.n,1);assert.equal(check.prepare("SELECT count(*) n FROM candidates").get()!.n,0);assert.equal(check.prepare("PRAGMA table_info(candidates)").all().some(column=>column.name==="requested_scope"),false);}finally{check.close();}
});
